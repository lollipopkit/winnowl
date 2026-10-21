import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { GateDecision } from './gate.js';

/** Every request, its decision, and how an allowed command ended. */
export interface CommandAuditScope {
  tenantId: string;
  jobId?: string;
  repositoryId?: string;
}

/** Stored text is capped: a command longer than the gate admits is denied anyway. */
const MAX_STORED = 8200;

export async function recordCommandDecision(
  db: Db,
  scope: CommandAuditScope,
  request: { command: string; purpose?: string },
  decision: GateDecision,
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('agent_commands')
    .values({
      id,
      tenant_id: scope.tenantId,
      job_id: scope.jobId ?? null,
      repository_id: scope.repositoryId ?? null,
      command: request.command.slice(0, MAX_STORED),
      purpose: request.purpose?.slice(0, 1000) ?? null,
      verdict: decision.verdict,
      decided_by: decision.decidedBy,
      rule: decision.rule,
      reason: decision.reason.slice(0, 1000),
      judge_cost_usd: decision.judgeCostUsd ?? null,
    })
    .execute();
  return id;
}

export async function recordCommandResult(
  db: Db,
  id: string,
  result: { exitCode: number | null; timedOut: boolean; oomKilled?: boolean; durationMs: number },
): Promise<void> {
  await db
    .updateTable('agent_commands')
    .set({
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      oom_killed: result.oomKilled ?? false,
      duration_ms: Math.round(result.durationMs),
      finished_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
}

/** The job's earlier commands, oldest first (the judge's context). */
export async function previousCommands(db: Db, jobId: string, limit = 8): Promise<{ command: string; verdict: 'allow' | 'deny' }[]> {
  const rows = await db
    .selectFrom('agent_commands')
    .select(['command', 'verdict'])
    .where('job_id', '=', jobId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.reverse();
}

export async function purgeCommandAudit(db: Db, tenantId: string, days: number, now = new Date()): Promise<number> {
  const r = await db
    .deleteFrom('agent_commands')
    .where('tenant_id', '=', tenantId)
    .where('created_at', '<', new Date(now.getTime() - days * 86_400_000))
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
