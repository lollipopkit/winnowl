import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { insertLearningProposal, newProposal } from './store.js';
import { FEEDBACK_CLASSES, type FeedbackClass, type LearningLocality } from './types.js';

export function isFeedbackClass(value: string): value is FeedbackClass {
  return (FEEDBACK_CLASSES as readonly string[]).includes(value);
}

/** Feedback classes that can become a rule when repeated. */
const RULE_WORTHY: ReadonlySet<FeedbackClass> = new Set<FeedbackClass>([
  'false-positive',
  'not-important',
  'already-known',
  'wrong-severity',
  'bad-suggestion',
]);

/** One feedback record for a pattern (caller groups by pattern). */
export interface FeedbackRecord {
  class: FeedbackClass;
}

export interface ProposeDecision {
  propose: boolean;
  reason: string;
  count: number;
}

/**
 * A single dismissal never becomes a rule; propose only when rule-worthy feedback for the same
 * pattern reaches the threshold (default 3). Proposals still need admin approval.
 */
export function shouldProposeFromFeedback(
  records: FeedbackRecord[],
  opts: { threshold?: number } = {},
): ProposeDecision {
  const threshold = opts.threshold ?? 3;
  const count = records.filter((r) => RULE_WORTHY.has(r.class)).length;
  if (count < threshold) {
    return { propose: false, reason: `重复不足(${count}/${threshold}),单次 dismiss 不成规则`, count };
  }
  return { propose: true, reason: `重复模式达阈值(${count} ≥ ${threshold})`, count };
}

export interface FeedbackInput {
  repositoryId?: string;
  fingerprint?: string;
  findingId?: string;
  class: FeedbackClass;
  actor?: string;
  note?: string;
}

export async function insertFeedback(db: Db, tenantId: string, input: FeedbackInput, now?: number): Promise<void> {
  await db
    .insertInto('feedbacks')
    .values({
      id: uuidv7(now),
      tenant_id: tenantId,
      repository_id: input.repositoryId ?? null,
      fingerprint: input.fingerprint ?? null,
      finding_id: input.findingId ?? null,
      class: input.class,
      actor: input.actor ?? null,
      note: input.note ?? null,
      created_at: new Date(now ?? Date.now()),
    })
    .execute();
}

export async function loadFeedbackFor(
  db: Db,
  tenantId: string,
  key: { repositoryId: string; fingerprint: string },
): Promise<FeedbackRecord[]> {
  const rows = await db
    .selectFrom('feedbacks')
    .select(['class'])
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', key.repositoryId)
    .where('fingerprint', '=', key.fingerprint)
    .execute();
  return rows.map((r) => ({ class: r.class as FeedbackClass }));
}

export interface AutoProposeInput {
  tenantId: string;
  repositoryId: string;
  fingerprint: string;
  /** Bot-generated finding claim (trusted source) the instruction is derived from. */
  claim: string;
  locality?: LearningLocality;
  selector?: string;
}

export interface AutoProposeResult {
  proposed: boolean;
  reason: string;
  /** Blocked by the injection guard; caller should record a security audit. */
  blocked?: boolean;
  proposalId?: string;
}

/**
 * Feedback-driven learning proposal; only proposes, never approves. Injection defences: the trigger
 * is a structured feedback command, the instruction derives from the bot's own claim, and
 * `isSuspicious` scans the derived text (hit = blocked, not persisted).
 */
export async function maybeAutoProposeLearning(
  db: Db,
  input: AutoProposeInput,
  opts: { threshold?: number; isSuspicious?: (text: string) => boolean; now?: number } = {},
): Promise<AutoProposeResult> {
  const records = await loadFeedbackFor(db, input.tenantId, { repositoryId: input.repositoryId, fingerprint: input.fingerprint });
  const decision = shouldProposeFromFeedback(records, opts.threshold !== undefined ? { threshold: opts.threshold } : {});
  if (!decision.propose) return { proposed: false, reason: decision.reason };

  const claimShort = input.claim.replace(/\s+/g, ' ').trim().slice(0, 200);
  const instruction = `对于类似「${claimShort}」的发现,本仓已多次反馈为噪音(${decision.count} 次);复审时据此降低报告优先级或抑制。`;
  const rationale = `自动提案(§P5):该模式收到 ${decision.count} 次「可成规则」反馈,达阈值。仍需人工审批。`;

  // Injection backstop: never persist suspicious derived text.
  if (opts.isSuspicious?.(instruction)) {
    return { proposed: false, reason: 'injection-suspected', blocked: true };
  }

  const proposal = newProposal({
    repositoryId: input.repositoryId,
    broadness: 'repository',
    ...(input.locality !== undefined ? { locality: input.locality } : {}),
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    instruction,
    rationale,
    proposedBy: 'auto',
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  await insertLearningProposal(db, input.tenantId, proposal, opts.now);
  return { proposed: true, reason: decision.reason, proposalId: proposal.id };
}
