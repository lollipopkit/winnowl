import { detectInjectionAttempt } from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import { botMention } from '@reviewbot/domain';
import {
  insertLearningProposal,
  learningProposalExists,
  listLearningProposals,
  newProposal,
  transitionAndPersist,
  type LearningActor,
  type LearningBroadness,
  type LearningProposal,
} from '@reviewbot/knowledge';
import type { ConversationTurnPayload } from './conversation-turn.js';
import type { botMessages } from './locale.js';
import { KNOWLEDGE_TRUSTED_PERMISSIONS, type ActorPermissionResolver } from './review-permissions.js';

type Messages = ReturnType<typeof botMessages>['conversation'];

const MAX_INSTRUCTION = 1000;
/** Shortest accepted id fragment. */
const MIN_ID_FRAGMENT = 6;

export interface ConversationLearningDeps {
  db: Db;
  payload: ConversationTurnPayload & { repositoryId: string };
  m: Messages;
  reply: (markdown: string) => Promise<void>;
  resolveActorPermission?: ActorPermissionResolver;
  /** `knowledge.learnings.require_repo_admin_approval`: false lets anyone's repository and self-scoped rules apply. */
  requireApproval: boolean;
}

/** Forge admin/maintain on this repository; a failed lookup counts as untrusted. */
export async function isKnowledgeTrusted(
  resolve: ActorPermissionResolver | undefined,
  repositoryId: string,
  payload: Pick<ConversationTurnPayload, 'actorLogin' | 'actorId'>,
): Promise<boolean> {
  if (!resolve) return false;
  const permission = await resolve(repositoryId, {
    login: payload.actorLogin,
    ...(payload.actorId ? { providerUserId: payload.actorId } : {}),
  }).catch(() => 'none' as const);
  return KNOWLEDGE_TRUSTED_PERMISSIONS.has(permission);
}

/** `provider:numericId` of the commenter, the form user learnings are matched by. */
async function actorSubjectRef(db: Db, repositoryId: string, actorId: string | undefined): Promise<string | undefined> {
  if (!actorId || !/^\d+$/.test(actorId)) return undefined;
  const row = await db
    .selectFrom('repositories')
    .innerJoin('provider_hosts', 'provider_hosts.id', 'repositories.provider_host_id')
    .select('provider_hosts.provider as provider')
    .where('repositories.id', '=', repositoryId)
    .executeTakeFirst();
  return row ? `${row.provider}:${actorId}` : undefined;
}

function scopeLabel(m: Messages, broadness: LearningBroadness): string {
  return broadness === 'organization' ? m.learningScopeOrganization() : broadness === 'user' ? m.learningScopeUser() : m.learningScopeRepository();
}

/**
 * `propose learning [org|me] <rule>`. Repository and self-scoped rules from forge admins/maintainers (from
 * anyone when the repository turned approval off) apply at once; the rest, and organization-wide rules from
 * anyone, wait for an admin.
 */
export async function proposeLearningFromComment(deps: ConversationLearningDeps, argument: string | undefined): Promise<void> {
  const { db, payload, m } = deps;
  const words = (argument ?? '').trim();
  const head = words.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  const broadness: LearningBroadness = head === 'org' ? 'organization' : head === 'me' ? 'user' : 'repository';
  const text = (broadness === 'repository' && head !== 'repo' ? words : words.slice(head.length)).trim();
  if (!text) {
    await deps.reply(m.learningUsage({ bot: botMention() }));
    return;
  }
  if (detectInjectionAttempt(text).suspicious) {
    await deps.reply(m.learningSuspicious());
    return;
  }
  const instruction = text.slice(0, MAX_INSTRUCTION);
  const subjectRef = broadness === 'user' ? await actorSubjectRef(db, payload.repositoryId, payload.actorId) : undefined;
  if (broadness === 'user' && !subjectRef) {
    await deps.reply(m.learningNoIdentity());
    return;
  }
  const repositoryId = broadness === 'repository' ? payload.repositoryId : null;
  if (await learningProposalExists(db, payload.tenantId, { instruction, repositoryId })) {
    await deps.reply(m.learningDuplicate());
    return;
  }
  const proposal = newProposal({
    repositoryId,
    broadness,
    ...(subjectRef ? { subjectRef } : {}),
    instruction,
    rationale: m.learningRationale({ actor: payload.actorLogin }),
    proposedBy: payload.actorLogin,
    sourceCommentRef: { nativeId: payload.commentNativeId ?? payload.target.nativeId },
  });
  await insertLearningProposal(db, payload.tenantId, proposal);

  const trusted =
    broadness !== 'organization' &&
    (!deps.requireApproval || (await isKnowledgeTrusted(deps.resolveActorPermission, payload.repositoryId, payload)));
  if (trusted) {
    const actor: LearningActor = {
      isTenantAdmin: false,
      repositoryAdminOf: payload.repositoryId,
      ...(subjectRef ? { subjectRef } : {}),
      ref: payload.actorLogin,
    };
    const result = await transitionAndPersist(db, payload.tenantId, proposal.id, { action: 'approve', actor });
    if (result.ok) {
      await deps.reply(m.learningApplied({ id: shortId(proposal.id), scope: scopeLabel(m, broadness), instruction }));
      return;
    }
  }
  await deps.reply(
    broadness === 'organization'
      ? m.learningProposedConsole({ id: shortId(proposal.id), scope: scopeLabel(m, broadness) })
      : m.learningProposed({ id: shortId(proposal.id), scope: scopeLabel(m, broadness), bot: botMention() }),
  );
}

/**
 * `approve learning <id prefix>`: forge admins/maintainers approve this repository's pending learnings; other
 * scopes are approved in the console, where tenant admins are known.
 */
export async function approveLearningFromComment(deps: ConversationLearningDeps, argument: string | undefined): Promise<void> {
  const { db, payload, m } = deps;
  const fragment = (argument ?? '').trim().split(/\s+/, 1)[0]?.replace(/^`|`$/g, '').toLowerCase() ?? '';
  if (fragment.length < MIN_ID_FRAGMENT) {
    await deps.reply(m.approveLearningUsage({ bot: botMention() }));
    return;
  }
  if (!(await isKnowledgeTrusted(deps.resolveActorPermission, payload.repositoryId, payload))) {
    await deps.reply(m.approveLearningNotAllowed());
    return;
  }
  const pending = (await listLearningProposals(db, payload.tenantId, { status: 'proposed' })).filter((p) => matchesIdFragment(p.id, fragment));
  const here = pending.filter((p) => p.broadness === 'repository' && p.repositoryId === payload.repositoryId);
  if (here.length !== 1) {
    const elsewhere = pending.find((p) => p.broadness !== 'repository');
    await deps.reply(
      elsewhere && here.length === 0
        ? m.approveLearningConsoleOnly({ id: shortId(elsewhere.id), scope: scopeLabel(m, elsewhere.broadness) })
        : m.approveLearningNotFound({ id: fragment }),
    );
    return;
  }
  const target: LearningProposal = here[0]!;
  const result = await transitionAndPersist(db, payload.tenantId, target.id, {
    action: 'approve',
    actor: { isTenantAdmin: false, repositoryAdminOf: payload.repositoryId, ref: payload.actorLogin },
  });
  await deps.reply(
    result.ok
      ? m.learningApproved({ id: shortId(target.id), instruction: target.instruction })
      : m.approveLearningNotFound({ id: fragment }),
  );
}

/** uuidv7 ids open with a timestamp shared by everything created the same weeks, so show the random tail. */
export function shortId(id: string): string {
  return id.slice(-8);
}

/** A full id, or a fragment from either end (the tail is what replies show). */
export function matchesIdFragment(id: string, fragment: string): boolean {
  const lower = id.toLowerCase();
  return lower.startsWith(fragment) || lower.endsWith(fragment);
}
