import { createDb, createPool } from '@reviewbot/db';
import {
  createMetricsServer,
  currentTraceCarrier,
  initMetrics,
  initTelemetry,
  registerQueueDepthGauge,
} from '@reviewbot/telemetry';
import {
  ensureRunnerPool,
  heartbeatWorker,
  pruneDeadWorkers,
  registerWorker,
  setJobTraceCarrierProvider,
  setWorkerMode,
} from '@reviewbot/queue';
import { pino } from 'pino';
import { loadEnv } from './env.js';
import { startFactFeedRefresher } from './fact-feeds.js';
import { runnerLanes } from './lanes.js';
import { startOrphanSweeps } from './orphan-sweep.js';
import { createPlatformModels } from './platform-models.js';
import { reviewPayloadFromSwept } from './review-ack.js';
import { destroyActiveSandboxes } from './review-in-sandbox.js';
import { createSandboxBackend } from './sandbox-backend.js';
import { runPeriodicEnqueue } from './scheduler.js';
import { createShutdown, parseDrainTimeoutMs, type Shutdown } from './shutdown.js';
import { Supervisor, totalLaneConcurrency } from './supervisor.js';
import { agentHandlers } from './wiring/agents.js';
import { conversationHandlers } from './wiring/conversation.js';
import { maintenanceHandlers, periodicSpecs, startModelCatalogSync } from './wiring/maintenance.js';
import { reviewHandlers } from './wiring/review.js';
import { createRunnerRuntime } from './wiring/runtime.js';
import { securityHandlers } from './wiring/security.js';

loadEnv();

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const telemetry = initTelemetry({ serviceName: 'winnowl-runner-supervisor' });
// Cross-job tracing: enqueue stores the current span's W3C carrier on the job row (queue stays telemetry-free).
setJobTraceCarrierProvider(() => currentTraceCarrier());

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.error('缺少环境变量 DATABASE_URL');
  process.exit(1);
}

const pool = createPool({ connectionString });
const db = createDb(pool);
// Model chain for non-review agents; the registry refreshes in the background every 5 minutes.
const platformModels = createPlatformModels(db);
const refreshPlatformModels = (): void =>
  void platformModels.refresh().catch((err) => logger.warn({ err: (err as Error)?.message }, '模型表刷新失败,沿用上一份'));
refreshPlatformModels();
setInterval(refreshPlatformModels, 5 * 60_000).unref();
// Pools are reused by name; creating one per start would accumulate same-named pools across restarts.
const poolId = await ensureRunnerPool(db, { name: process.env.RUNNER_POOL ?? 'default' });
// Clear worker rows left by previous processes (stale heartbeat): the table lists live processes, not history.
const pruned = await pruneDeadWorkers(db);
if (pruned > 0) logger.info({ pruned }, '启动清理:已删除心跳早停的 worker 登记');
const lanes = runnerLanes();
const workerId = await registerWorker(db, {
  poolId,
  version: process.env.APP_VERSION ?? '0.0.0',
  capabilities: {},
  // claimJob caps in-flight jobs per worker at max_concurrency: it must cover every lane.
  maxConcurrency: totalLaneConcurrency(lanes),
});
logger.info(
  { lanes: lanes.map(({ name, concurrency }) => ({ name, concurrency })) },
  'runner lanes configured',
);

// Built after worker registration: backends label sandboxes with the workerId for orphan cleanup.
const { sandbox } = createSandboxBackend({ workerId, logger });
const orphanSweepTimer = await startOrphanSweeps({ db, logger, sandbox });

const runtime = createRunnerRuntime({ db, logger, sandbox, platformModels });
const handlers = {
  ...maintenanceHandlers(runtime),
  ...(await reviewHandlers(runtime)),
  ...conversationHandlers(runtime),
  ...securityHandlers(runtime),
  ...agentHandlers(runtime),
};

const supervisor = new Supervisor({
  db,
  sandbox,
  workerId,
  handlers,
  logger: (message, data) => logger.info(data ?? {}, message),
  tracer: telemetry.tracer('runner-supervisor'),
  lanes,
  // Lease expired (worker crash/timeout) → review timeout ack: PR check-run neutral.
  onJobTimedOut: async (job) => {
    const p = reviewPayloadFromSwept(job.type, job.payload);
    if (p) {
      await runtime.reviewAck.onReviewJobTimedOut(p);
      await runtime.statusComment.failed(p).catch(() => undefined);
    }
  },
});

// Queue depth gauge: counts jobs (queued/running) at scrape time.
registerQueueDepthGauge(async () => {
  const rows = await db
    .selectFrom('jobs')
    .select(['status', db.fn.countAll().as('n')])
    .where('status', 'in', ['queued', 'running', 'leased'])
    .groupBy('status')
    .execute();
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  return {
    queued: (by.get('queued') ?? 0) + (by.get('leased') ?? 0),
    running: by.get('running') ?? 0,
  };
});

const catalogTimer = startModelCatalogSync(db, logger);
// Ecosystem facts from operator-registered release notes (fact-feeds.ts; hourly, unref'd timer).
startFactFeedRefresher({ db, resolveModel: (t) => platformModels.source(t), exaApiKey: process.env.EXA_API_KEY, log: (l, m, d) => logger[l](d ?? {}, m) });

const specs = periodicSpecs();
const periodicTimer = setInterval(() => {
  void runPeriodicEnqueue(db, specs, { log: (m, d) => logger.warn(d ?? {}, m) })
    .then(({ enqueued, skipped }) => {
      if (enqueued > 0) logger.info({ enqueued, skipped }, '周期任务入队');
    })
    .catch((err) => logger.warn({ err: (err as Error)?.message }, '周期任务入队失败'));
}, 60 * 1000);
periodicTimer.unref();

let shuttingDown = false;
let signalled = false;

// Graceful drain on SIGTERM/SIGINT (see shutdown.ts). Default 0 aborts immediately; the container stop
// grace period must exceed this value plus the 8s abort grace.
const drainTimeoutMs = parseDrainTimeoutMs(process.env.RUNNER_DRAIN_TIMEOUT_MS);

function createRunnerShutdown(supervisorRun: Promise<void>): Shutdown {
  return createShutdown({
    drainTimeoutMs,
    stopClaiming: async () => {
      // The mode flip is the atomic claim gate (claimJob locks the worker row); requestStop also
      // stops the local loop in case the DB write fails, and releases a claim that was in flight.
      await setWorkerMode(db, workerId, 'draining').catch(() => undefined);
      supervisor.requestStop();
    },
    idle: supervisorRun,
    inFlightJobs: () => supervisor.inFlightJobs(),
    heartbeat: () => heartbeatWorker(db, workerId),
    abortInFlight: () => supervisor.abortInFlight(),
    destroySandboxes: () => destroyActiveSandboxes(),
    release: (ids) => supervisor.releaseInFlight(ids),
    log: {
      info: (data, message) => logger.info(data, message),
      warn: (data, message) => logger.warn(data, message),
    },
  });
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM', runnerShutdown: Shutdown): Promise<void> {
  if (shuttingDown) {
    // A repeated signal during a signal-driven shutdown forces the abort path of a drain.
    if (signalled) void runnerShutdown.request(signal);
    return;
  }
  shuttingDown = signalled = true;
  clearInterval(catalogTimer);
  clearInterval(periodicTimer);
  clearInterval(orphanSweepTimer);
  await runnerShutdown.request(signal);

  await new Promise<void>((resolve) => metricsServer.close(() => resolve())).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(0);
}

// No HTTP framework in the runner: a minimal /metrics + /health server for Prometheus.
initMetrics('winnowl-runner-supervisor');
const metricsPort = Number(process.env.METRICS_PORT ?? 9464);
// /metrics needs `Authorization: Bearer <METRICS_TOKEN>` (see telemetry metricsAccess).
const metricsServer = createMetricsServer();
metricsServer.listen(metricsPort, () =>
  logger.info({ metricsPort }, 'runner metrics /metrics 就绪'),
);

logger.info({ workerId, poolId }, 'runner-supervisor 启动');
const supervisorRun = supervisor.run();
const runnerShutdown = createRunnerShutdown(supervisorRun);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // `on`, not `once`: a second signal must reach the orchestrator to force the abort path.
  process.on(signal, () => void shutdown(signal, runnerShutdown));
}
await supervisorRun;
if (!shuttingDown) {
  shuttingDown = true;
  clearInterval(catalogTimer);
  clearInterval(periodicTimer);
  clearInterval(orphanSweepTimer);
  await setWorkerMode(db, workerId, 'offline').catch(() => undefined);
  await new Promise<void>((resolve) => metricsServer.close(() => resolve())).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
}
