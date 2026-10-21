import { listActionPlans } from '@reviewbot/actions';
import type { Db } from '@reviewbot/db';
import { listAgentMemoryProposals, listPendingGlobalLearnings } from '@reviewbot/knowledge';

export type InboxKind = 'plan' | 'rule' | 'memory' | 'recommendation' | 'dependency' | 'installation' | 'notification';

export interface InboxItem {
  /** `${kind}:${sourceId}` */
  id: string;
  kind: InboxKind;
  sourceId: string;
  createdAt: string;
  /** Present once handled; the outcome is the source's own status (approved, declined, read, …). */
  decided?: { outcome: string; at: string };
  plan?: {
    conversationId: string;
    actions: { type: string; description: string }[];
    requiredPermissions: string[];
    expiresAt: string;
    repository: string | null;
    changeNumber: number | null;
  };
  rule?: { instruction: string; rationale: string; broadness: string; repository: string | null; proposedBy: string };
  memory?: { kind: string; title: string; summary: string; body: string; repository: string | null; proposedBy: string | null };
  recommendation?: { instruction: string; rationale: string; selector: string | null };
  dependency?: { source: string; target: string; kind: string; rationale: string | null; proposedBy: string | null };
  installation?: { provider: string; accountLogin: string; installerLogin: string };
  notification?: { kind: string; title: string; body: string; link: string | null };
}

export interface InboxViewer {
  tenantId: string;
  actorId: string | null;
  canApproveActions: boolean;
  canApproveRules: boolean;
  canConfigure: boolean;
  isOperator: boolean;
}

const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const iso = (v: unknown): string => new Date(v as string).toISOString();

async function repoNames(db: Db, tenantId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .selectFrom('repositories')
    .select(['id', 'namespace', 'name'])
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, `${r.namespace}/${r.name}`]));
}

async function planItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.actorId) return [];
  const plans = (await listActionPlans(db, v.tenantId, 200)).filter(
    (p) => p.actorId === v.actorId || (p.approvalActor === 'any-authorized' && v.canApproveActions),
  );
  const shown = plans.filter((p) =>
    view === 'pending' ? p.status === 'proposed' && p.expiresAt > now : p.status !== 'proposed' || p.expiresAt <= now,
  );
  if (shown.length === 0) return [];
  const convs = await db
    .selectFrom('conversations as c')
    .leftJoin('change_requests as cr', 'cr.id', 'c.change_request_id')
    .select(['c.id', 'c.repository_id', 'cr.number', 'c.created_at'])
    .where('c.tenant_id', '=', v.tenantId)
    .where(
      'c.id',
      'in',
      shown.map((p) => p.conversationId),
    )
    .execute();
  const byConv = new Map(convs.map((c) => [c.id, c]));
  const names = await repoNames(db, v.tenantId, convs.map((c) => c.repository_id));
  const times = await db
    .selectFrom('action_plans')
    .select(['id', 'created_at', 'updated_at'])
    .where('tenant_id', '=', v.tenantId)
    .where(
      'id',
      'in',
      shown.map((p) => p.id),
    )
    .execute();
  const timeOf = new Map(times.map((t) => [t.id, t]));
  return shown.flatMap((p) => {
    const conv = byConv.get(p.conversationId);
    const t = timeOf.get(p.id);
    if (!t) return [];
    const expired = p.status === 'proposed' && p.expiresAt <= now;
    if (view === 'done' && now - new Date(t.updated_at as unknown as string).getTime() > DONE_WINDOW_MS) return [];
    return [
      {
        id: `plan:${p.id}`,
        kind: 'plan' as const,
        sourceId: p.id,
        createdAt: iso(t.created_at),
        ...(view === 'done'
          ? { decided: { outcome: expired ? 'expired' : p.status, at: expired ? new Date(p.expiresAt).toISOString() : iso(t.updated_at) } }
          : {}),
        plan: {
          conversationId: p.conversationId,
          actions: p.actions.map((a) => ({ type: a.type, description: a.description })),
          requiredPermissions: p.requiredPermissions,
          expiresAt: new Date(p.expiresAt).toISOString(),
          repository: conv?.repository_id ? (names.get(conv.repository_id) ?? null) : null,
          changeNumber: conv?.number ?? null,
        },
      },
    ];
  });
}

async function ruleItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.canApproveRules) return [];
  let q = db
    .selectFrom('learning_proposals')
    .select(['id', 'repository_id', 'instruction', 'rationale', 'broadness', 'proposed_by', 'status', 'created_at', 'updated_at'])
    .where('tenant_id', '=', v.tenantId);
  q =
    view === 'pending'
      ? q.where('status', '=', 'proposed')
      : q.where('status', 'in', ['approved', 'rejected']).where('updated_at', '>', new Date(now - DONE_WINDOW_MS));
  const rows = await q.orderBy('created_at', 'desc').limit(200).execute();
  const names = await repoNames(db, v.tenantId, rows.map((r) => r.repository_id));
  return rows.map((r) => ({
    id: `rule:${r.id}`,
    kind: 'rule' as const,
    sourceId: r.id,
    createdAt: iso(r.created_at),
    ...(view === 'done' ? { decided: { outcome: r.status, at: iso(r.updated_at) } } : {}),
    rule: {
      instruction: r.instruction,
      rationale: r.rationale,
      broadness: r.broadness,
      repository: r.repository_id ? (names.get(r.repository_id) ?? null) : null,
      proposedBy: r.proposed_by,
    },
  }));
}

/** Repository memories drafted from outside commenters' words, waiting for an admin. */
async function memoryItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.canApproveRules) return [];
  const rows = await listAgentMemoryProposals(db, v.tenantId, view, { since: now - DONE_WINDOW_MS });
  const names = await repoNames(db, v.tenantId, rows.map((r) => r.repositoryId));
  return rows.map((r) => ({
    id: `memory:${r.id}`,
    kind: 'memory' as const,
    sourceId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    ...(view === 'done'
      ? { decided: { outcome: r.status === 'rejected' ? 'rejected' : 'approved', at: new Date(r.updatedAt).toISOString() } }
      : {}),
    memory: {
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      body: r.body,
      repository: names.get(r.repositoryId) ?? null,
      proposedBy: r.proposedBy ?? null,
    },
  }));
}

async function recommendationItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.canApproveRules) return [];
  if (view === 'pending') {
    const pending = await listPendingGlobalLearnings(db, v.tenantId);
    const created = pending.length
      ? await db
          .selectFrom('global_learnings')
          .select(['id', 'created_at'])
          .where(
            'id',
            'in',
            pending.map((g) => g.id),
          )
          .execute()
      : [];
    const createdOf = new Map(created.map((c) => [c.id, iso(c.created_at)]));
    return pending.map((g) => ({
      id: `recommendation:${g.id}`,
      kind: 'recommendation' as const,
      sourceId: g.id,
      createdAt: createdOf.get(g.id) ?? new Date(now).toISOString(),
      recommendation: { instruction: g.instruction, rationale: g.rationale, selector: g.selector ?? null },
    }));
  }
  const rows = await db
    .selectFrom('global_learning_adoptions as a')
    .innerJoin('global_learnings as g', 'g.id', 'a.global_learning_id')
    .select(['g.id', 'g.instruction', 'g.rationale', 'g.selector', 'g.created_at', 'a.status', 'a.decided_at'])
    .where('a.tenant_id', '=', v.tenantId)
    .where('a.decided_at', '>', new Date(now - DONE_WINDOW_MS))
    .orderBy('a.decided_at', 'desc')
    .limit(200)
    .execute();
  return rows.map((r) => ({
    id: `recommendation:${r.id}`,
    kind: 'recommendation' as const,
    sourceId: r.id,
    createdAt: iso(r.created_at),
    decided: { outcome: r.status, at: iso(r.decided_at) },
    recommendation: { instruction: r.instruction, rationale: r.rationale, selector: r.selector },
  }));
}

async function dependencyItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.canConfigure) return [];
  let q = db
    .selectFrom('repository_relationships')
    .select(['id', 'source_repository_id', 'target_repository_id', 'kind', 'rationale', 'proposed_by', 'status', 'created_at', 'updated_at'])
    .where('tenant_id', '=', v.tenantId);
  q =
    view === 'pending'
      ? q.where('status', '=', 'proposed')
      : q
          .where('status', 'in', ['active', 'rejected'])
          .where('proposed_by', 'is not', null)
          .where('updated_at', '>', new Date(now - DONE_WINDOW_MS));
  const rows = await q.orderBy('created_at', 'desc').limit(200).execute();
  const names = await repoNames(db, v.tenantId, rows.flatMap((r) => [r.source_repository_id, r.target_repository_id]));
  return rows.map((r) => ({
    id: `dependency:${r.id}`,
    kind: 'dependency' as const,
    sourceId: r.id,
    createdAt: iso(r.created_at),
    ...(view === 'done' ? { decided: { outcome: r.status === 'active' ? 'approved' : 'rejected', at: iso(r.updated_at) } } : {}),
    dependency: {
      source: names.get(r.source_repository_id) ?? r.source_repository_id,
      target: names.get(r.target_repository_id) ?? r.target_repository_id,
      kind: r.kind,
      rationale: r.rationale,
      proposedBy: r.proposed_by,
    },
  }));
}

async function installationItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  if (!v.isOperator) return [];
  let q = db
    .selectFrom('pending_installations')
    .select(['id', 'provider', 'account_login', 'installer_login', 'status', 'decided_at', 'created_at']);
  q =
    view === 'pending'
      ? q.where('status', '=', 'pending')
      : q.where('status', '!=', 'pending').where('decided_at', '>', new Date(now - DONE_WINDOW_MS));
  const rows = await q.orderBy('created_at', 'desc').limit(200).execute();
  return rows.map((r) => ({
    id: `installation:${r.id}`,
    kind: 'installation' as const,
    sourceId: r.id,
    createdAt: iso(r.created_at),
    ...(view === 'done' && r.decided_at ? { decided: { outcome: r.status, at: iso(r.decided_at) } } : {}),
    installation: { provider: r.provider, accountLogin: r.account_login, installerLogin: r.installer_login },
  }));
}

async function notificationItems(db: Db, v: InboxViewer, view: 'pending' | 'done', now: number): Promise<InboxItem[]> {
  let q = db
    .selectFrom('notifications')
    .select(['id', 'kind', 'title', 'body', 'link', 'read_at', 'created_at'])
    .where('tenant_id', '=', v.tenantId);
  q = view === 'pending' ? q.where('read_at', 'is', null) : q.where('read_at', '>', new Date(now - DONE_WINDOW_MS));
  const rows = await q.orderBy('created_at', 'desc').limit(200).execute();
  return rows.map((r) => ({
    id: `notification:${r.id}`,
    kind: 'notification' as const,
    sourceId: r.id,
    createdAt: iso(r.created_at),
    ...(view === 'done' && r.read_at ? { decided: { outcome: 'read', at: iso(r.read_at) } } : {}),
    notification: { kind: r.kind, title: r.title, body: r.body, link: r.link },
  }));
}

/** Everything the viewer can decide, newest first; `done` covers the last 30 days. */
export async function listInbox(db: Db, viewer: InboxViewer, view: 'pending' | 'done', now = Date.now()): Promise<InboxItem[]> {
  const groups = await Promise.all([
    planItems(db, viewer, view, now),
    ruleItems(db, viewer, view, now),
    memoryItems(db, viewer, view, now),
    recommendationItems(db, viewer, view, now),
    dependencyItems(db, viewer, view, now),
    installationItems(db, viewer, view, now),
    notificationItems(db, viewer, view, now),
  ]);
  const key = (i: InboxItem): string => i.decided?.at ?? i.createdAt;
  return groups.flat().sort((a, b) => key(b).localeCompare(key(a)));
}
