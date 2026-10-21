import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

// record* functions are always safe to call; metrics are created lazily in a private registry.

const registry = new Registry();
let started = false;

/** Idempotent. */
export function initMetrics(serviceName: string): void {
  if (started) return;
  started = true;
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
}

export function metricsText(): Promise<string> {
  return registry.metrics();
}

export function metricsContentType(): string {
  return registry.contentType;
}

/** Requires `Bearer <METRICS_TOKEN>`; without a configured token `/metrics` is 404 so it never leaks by default. */
export function metricsAccess(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 200 | 401 | 404 {
  const token = env.METRICS_TOKEN?.trim();
  if (!token) return 404;
  const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return presented && timingSafeEqual(a, b) ? 200 : 401;
}

/** Minimal HTTP server for processes without a framework: `/metrics` (token-gated) + `/health`. */
export function createMetricsServer(env: NodeJS.ProcessEnv = process.env): Server {
  return createServer((req, res) => {
    if (req.url === '/metrics') {
      const access = metricsAccess(req.headers.authorization, env);
      if (access !== 200) {
        res.writeHead(access);
        res.end();
        return;
      }
      void registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      });
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// get-or-create avoids prom-client's "already registered" error.
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function counter(name: string, help: string, labelNames: string[]): Counter {
  let c = counters.get(name);
  if (!c) {
    c = new Counter({ name, help, labelNames, registers: [registry] });
    counters.set(name, c);
  }
  return c;
}

function gauge(name: string, help: string, labelNames: string[]): Gauge {
  let g = gauges.get(name);
  if (!g) {
    g = new Gauge({ name, help, labelNames, registers: [registry] });
    gauges.set(name, g);
  }
  return g;
}

function histogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = new Histogram({ name, help, labelNames, buckets, registers: [registry] });
    histograms.set(name, h);
  }
  return h;
}

export function recordJob(type: string, outcome: 'completed' | 'failed', durationSec: number): void {
  counter('winnowl_jobs_total', 'Jobs finished by type and outcome', ['type', 'outcome']).inc({ type, outcome });
  if (durationSec >= 0) {
    histogram('winnowl_job_duration_seconds', 'Job wall-clock duration by type', ['type'], [1, 5, 15, 60, 180, 600, 1800]).observe({ type }, durationSec);
  }
}

export function recordReview(event: string): void {
  counter('winnowl_reviews_total', 'Reviews by published event', ['event']).inc({ event });
}

export function recordPluginCall(plugin: string, tool: string, keySource: string): void {
  counter('winnowl_plugin_calls_total', 'Plugin external tool calls', ['plugin', 'tool', 'key_source']).inc({ plugin, tool, key_source: keySource });
}

export function recordWebhook(provider: string, status: string): void {
  counter('winnowl_webhook_events_total', 'Webhook deliveries by provider and status', ['provider', 'status']).inc({ provider, status });
}

/** Labelled by model_source (platform|byok) because BYOK spend is not ours. */
export function recordReviewCost(modelSource: string, costUsd: number, inputTokens: number, outputTokens: number): void {
  counter('winnowl_review_cost_usd_total', 'Cumulative review LLM cost (USD) by model source', ['model_source']).inc({ model_source: modelSource }, costUsd);
  const tokens = counter('winnowl_review_tokens_total', 'Cumulative review LLM tokens by model source and direction', ['model_source', 'direction']);
  tokens.inc({ model_source: modelSource, direction: 'input' }, inputTokens);
  tokens.inc({ model_source: modelSource, direction: 'output' }, outputTokens);
}

/**
 * failure_kind separates gateway problems from model behaviour; it is `none` on success rather than
 * empty so PromQL need not distinguish a missing label.
 */
export function recordLlmCall(
  model: string,
  outcome: 'ok' | 'error',
  failureKind: string,
  durationSec: number,
): void {
  counter('winnowl_llm_calls_total', 'LLM stream calls by model, outcome and failure kind', ['model', 'outcome', 'failure_kind']).inc({
    model,
    outcome,
    failure_kind: failureKind,
  });
  if (durationSec >= 0) {
    histogram('winnowl_llm_call_duration_seconds', 'LLM stream call wall-clock duration by model and outcome', ['model', 'outcome'], [1, 5, 15, 60, 180, 600]).observe(
      { model, outcome },
      durationSec,
    );
  }
}

export function recordFinding(severity: string, blocking: boolean): void {
  counter('winnowl_findings_total', 'Published findings by severity and blocking', ['severity', 'blocking']).inc({ severity, blocking: String(blocking) });
}

/** 1 = the app's hook URL differs from the expected one; a lost webhook is otherwise silent on our side. */
export function recordWebhookConfigDrift(drifted: boolean): void {
  gauge('winnowl_webhook_config_drift', 'GitHub App webhook config drifted from expected (1=drifted)', []).set(drifted ? 1 : 0);
}

export function recordDependencyScan(manifests: number, vulnerabilities: number): void {
  counter('winnowl_dependency_scans_total', 'osv-scanner dependency scans run', []).inc();
  if (manifests > 0) counter('winnowl_dependency_manifests_total', 'Dependency manifests scanned', []).inc(manifests);
  if (vulnerabilities > 0) counter('winnowl_dependency_vulnerabilities_total', 'Dependency vulnerabilities found by scanner', []).inc(vulnerabilities);
}

/** Read at scrape time; idempotent. A failed read reports -1 to tell it apart from a real 0. */
export function registerQueueDepthGauge(fetchDepth: () => Promise<{ queued: number; running: number }>): void {
  if (registry.getSingleMetric('winnowl_queue_depth')) return;
  new Gauge({
    name: 'winnowl_queue_depth',
    help: 'Job queue depth by status (queued|running)',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      try {
        const d = await fetchDepth();
        this.set({ status: 'queued' }, d.queued);
        this.set({ status: 'running' }, d.running);
      } catch {
        this.set({ status: 'queued' }, -1);
        this.set({ status: 'running' }, -1);
      }
    },
  });
}
