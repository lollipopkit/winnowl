import type {
  Actor,
  ChangeRequest,
  ChangeRequestCapabilities,
  ChangeRequestRef,
  IssueRef,
  ProviderHostRef,
  RepositoryRef,
  Revision,
} from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import {
  ProviderError,
  UnsupportedCapabilityError,
  type BranchRef,
  type ReviewBatch,
  type ReviewReceipt,
  type ChangeRequestReceipt,
  type CreateChangeRequestInput,
  type ChangedFile,
  type RepositoryPermission,
  type CheckInput,
  type CheckReceipt,
  type Commit,
  type CommentReceipt,
  type CommentRef,
  type ReactionContent,
  type DiscussionTarget,
  type DiscussionThread,
  type DiscussionThreadRef,
  type GitCommitIdentity,
  type IdempotencyContext,
  type TopLevelComment,
  type IssueContent,
  type IssueInput,
  type IssueReceipt,
  type PipelineJob,
  type PipelineJobRef,
  type PipelineLogs,
  type PipelineRun,
  type PipelineRunRef,
  type ProviderAnchor,
  type ProviderDiff,
  type ProviderWebhookEvent,
  type RawWebhookDelivery,
  type ReviewRecord,
  type RichComment,
  type SourceControlProvider,
  type WebhookVerificationResult,
  hasIdempotencyMarker,
  withIdempotencyMarker,
} from '@reviewbot/provider-contracts';
import type { RestClient } from '@reviewbot/provider-http';
import { gitlabCapabilities } from './capabilities.js';
import { normalizeGitlabWebhook, verifyGitlabWebhook } from './webhook.js';

export interface GlProjectCoords {
  projectId: string;
}

export interface GitlabProviderOptions {
  client: RestClient;
  host: ProviderHostRef;
  resolveProject: (repositoryId: string) => GlProjectCoords | Promise<GlProjectCoords>;
  now?: () => number;
}

/** GitLab has no separate conclusion: a terminal status is the conclusion. */
const GL_TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped']);

interface GlMr {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author: { id: number; username: string };
  labels?: string[];
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string };
}

function toActor(user: { id: number; username: string }): Actor {
  return { providerUserId: String(user.id), login: user.username, type: 'user' };
}

export class GitlabProvider implements SourceControlProvider {
  readonly kind = 'gitlab' as const;

  constructor(private readonly options: GitlabProviderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async pid(repositoryId: string): Promise<string> {
    const { projectId } = await this.options.resolveProject(repositoryId);
    return projectId;
  }

  private async getMr(projectId: string, iid: number): Promise<GlMr> {
    const res = await this.options.client.get<GlMr>(`projects/${projectId}/merge_requests/${iid}`);
    return res.data;
  }

  identity = {
    botActor: async (): Promise<Actor> => {
      const res = await this.options.client.get<{ id: number; username: string }>('user');
      return toActor(res.data);
    },

    /** The bot is a regular account: `commit_email`, else `email`, else null. */
    commitIdentity: async (): Promise<GitCommitIdentity | null> => {
      const res = await this.options.client.get<{
        username: string;
        name?: string;
        email?: string;
        commit_email?: string;
      }>('user');
      const email = res.data.commit_email ?? res.data.email;
      if (!email) return null;
      return { name: res.data.name ?? res.data.username, email };
    },
  };

  /** GitLab has no user.type=Bot, so isBot compares author ids against this. */
  private selfActorP?: Promise<Actor>;
  private botActorCached(): Promise<Actor> {
    return (this.selfActorP ??= this.identity.botActor());
  }

  repositories = {
    get: async (ref: RepositoryRef): Promise<RepositoryRef> => {
      await this.options.client.get(`projects/${ref.nativeId}`);
      return ref;
    },
    listForInstallation: async (_installationId: string): Promise<RepositoryRef[]> => [],
    /** The files API requires a ref and a fully URL-encoded path (`/` -> `%2F`); 404 -> null. */
    getFileContent: async (ref: RepositoryRef, path: string, gitRef?: string): Promise<string | null> => {
      try {
        const res = await this.options.client.get<{ content?: string; encoding?: string }>(
          `projects/${encodeURIComponent(ref.nativeId)}/repository/files/${encodeURIComponent(path)}`,
          { query: { ref: gitRef ?? ref.defaultBranch } },
        );
        if (typeof res.data.content !== 'string') return null;
        return Buffer.from(res.data.content, 'base64').toString('utf8');
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return null;
        throw error;
      }
    },
    // `members/all` includes members inherited from groups. Look up by numeric id (usernames can
    // change). A non-member gets 404 -> none.
    getActorPermission: async (ref: RepositoryRef, actor: { login: string; providerUserId?: string }): Promise<RepositoryPermission> => {
      if (!actor.providerUserId) return 'none';
      try {
        const res = await this.options.client.get<{ access_level?: number }>(
          `projects/${encodeURIComponent(ref.nativeId)}/members/all/${encodeURIComponent(actor.providerUserId)}`,
        );
        const level = res.data.access_level ?? 0;
        if (level >= 50) return 'admin'; // owner
        if (level >= 40) return 'maintain'; // maintainer
        if (level >= 30) return 'write'; // developer
        if (level >= 20) return 'triage'; // reporter
        if (level >= 10) return 'read'; // guest
        return 'none';
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return 'none';
        throw error;
      }
    },
  };

  private buildRevision(ref: ChangeRequestRef, mr: GlMr): Revision {
    const refs = mr.diff_refs ?? { base_sha: '', start_sha: '', head_sha: '' };
    return {
      id: uuidv7(this.now()),
      changeRequestId: ref.id,
      baseSha: refs.start_sha || refs.base_sha,
      headSha: refs.head_sha,
      mergeBaseSha: refs.base_sha,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  changes = {
    get: async (ref: ChangeRequestRef): Promise<ChangeRequest> => {
      const projectId = await this.pid(ref.repositoryId);
      const mr = await this.getMr(projectId, ref.number);
      const isFork =
        mr.source_project_id !== undefined &&
        mr.target_project_id !== undefined &&
        mr.source_project_id !== mr.target_project_id;
      const state: ChangeRequest['state'] =
        mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open';
      return {
        // The forge's own id, as webhooks report it: callers may only know the number.
        ref: { ...ref, nativeId: String(mr.id) },
        revision: this.buildRevision(ref, mr),
        title: mr.title,
        description: mr.description ?? '',
        state,
        draft: mr.draft ?? mr.work_in_progress ?? false,
        author: toActor(mr.author),
        labels: mr.labels ?? [],
        reviewers: [],
        linkedIssues: [],
        mergeability: 'unknown',
        trust: isFork ? 'fork-public' : 'same-repo-trusted',
        capabilities: gitlabCapabilities(),
      };
    },

    getRevision: async (ref: ChangeRequestRef): Promise<Revision> => {
      const projectId = await this.pid(ref.repositoryId);
      const mr = await this.getMr(projectId, ref.number);
      return this.buildRevision(ref, mr);
    },

    getDescription: async (ref: ChangeRequestRef): Promise<string> => {
      const projectId = await this.pid(ref.repositoryId);
      const mr = await this.getMr(projectId, ref.number);
      return mr.description ?? '';
    },

    updateDescription: async (ref: ChangeRequestRef, body: string): Promise<void> => {
      const projectId = await this.pid(ref.repositoryId);
      await this.options.client.put(`projects/${projectId}/merge_requests/${ref.number}`, { body: { description: body } });
    },

    listCommits: async (ref: ChangeRequestRef): Promise<Commit[]> => {
      const projectId = await this.pid(ref.repositoryId);
      const commits = await this.options.client.getAllPages<
        { id: string; message: string; parent_ids?: string[]; created_at?: string }
      >(`projects/${projectId}/merge_requests/${ref.number}/commits`, { query: { per_page: 100 } });
      return commits.map((c) => ({
        sha: c.id,
        message: c.message,
        ...(c.created_at ? { authoredAt: c.created_at } : {}),
        parents: c.parent_ids ?? [],
      }));
    },

    listChangedFiles: async (ref: ChangeRequestRef): Promise<ChangedFile[]> => {
      const projectId = await this.pid(ref.repositoryId);
      // `/diffs` (paginated), not `/changes`, which truncates past the instance's max_diff_files.
      const diffs = await this.options.client.getAllPages<{
        old_path: string;
        new_path: string;
        new_file: boolean;
        deleted_file: boolean;
        renamed_file: boolean;
      }>(`projects/${projectId}/merge_requests/${ref.number}/diffs`, { query: { per_page: 100 } });
      return diffs.map((c) => ({
        oldPath: c.old_path,
        newPath: c.new_path,
        status: c.new_file ? 'added' : c.deleted_file ? 'deleted' : c.renamed_file ? 'renamed' : 'modified',
        additions: 0,
        deletions: 0,
      }));
    },

    getProviderDiff: async (ref: ChangeRequestRef): Promise<ProviderDiff> => {
      const projectId = await this.pid(ref.repositoryId);
      const diffs = await this.options.client.getAllPages<{ diff: string }>(
        `projects/${projectId}/merge_requests/${ref.number}/diffs`,
        { query: { per_page: 100 } },
      );
      return { raw: diffs.map((c) => c.diff).join('\n'), truncated: false };
    },

    listReviews: async (_ref: ChangeRequestRef): Promise<ReviewRecord[]> => [],

    create: async (
      repo: RepositoryRef,
      input: CreateChangeRequestInput,
      _idem: IdempotencyContext,
    ): Promise<ChangeRequestReceipt> => {
      // Idempotent by source branch (a second delivery of the same stacked branch updates its MR).
      const open = await this.options.client.get<{ id: number; iid: number; web_url?: string }[]>(
        `projects/${repo.nativeId}/merge_requests`,
        { query: { source_branch: input.sourceBranch, target_branch: input.targetBranch, state: 'opened', per_page: 1 } },
      );
      const existing = open.data[0];
      if (existing) {
        await this.options.client.put(`projects/${repo.nativeId}/merge_requests/${existing.iid}`, {
          body: { title: input.title, description: input.body.markdown },
        });
        return {
          ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(existing.id), number: existing.iid, kind: 'merge-request' },
          ...(existing.web_url ? { url: existing.web_url } : {}),
        };
      }
      const res = await this.options.client.post<{ id: number; iid: number; web_url?: string }>(
        `projects/${repo.nativeId}/merge_requests`,
        {
          body: {
            title: input.title,
            source_branch: input.sourceBranch,
            target_branch: input.targetBranch,
            description: input.body.markdown,
          },
        },
      );
      return {
        ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(res.data.id), number: res.data.iid, kind: 'merge-request' },
        ...(res.data.web_url ? { url: res.data.web_url } : {}),
      };
    },
  };

  discussions = {
    listThreads: async (target: DiscussionTarget): Promise<DiscussionThread[]> => {
      if (target.kind !== 'change-request') return [];
      const projectId = await this.pid(target.ref.repositoryId);
      const discussions = await this.options.client.getAllPages<
        { id: string; notes: { id: number; author: { id: number; username: string }; body: string; created_at: string }[]; resolved?: boolean }
      >(`projects/${projectId}/merge_requests/${target.ref.number}/discussions`, { query: { per_page: 100 } });
      return discussions.map((d) => ({
        ref: { nativeId: d.id, changeRequest: target.ref },
        resolved: d.resolved ?? false,
        comments: d.notes.map((n) => ({
          nativeId: String(n.id),
          author: toActor(n.author),
          body: n.body,
          createdAt: n.created_at,
          isBot: false,
        })),
      }));
    },

    listTopLevelComments: async (target: DiscussionTarget): Promise<TopLevelComment[]> => {
      const projectId = await this.pid(target.ref.repositoryId);
      const self = await this.botActorCached();
      const base =
        target.kind === 'change-request'
          ? `projects/${projectId}/merge_requests/${target.ref.number}/notes`
          : `projects/${projectId}/issues/${target.ref.number}/notes`;
      // Exclude system notes (GitLab-generated events).
      const notes = await this.options.client.getAllPages<
        { id: number; body: string; system?: boolean; author: { id: number; username: string } }
      >(base, { query: { per_page: 100 } });
      return notes
        .filter((n) => !n.system)
        .map((n) => ({ nativeId: String(n.id), body: n.body ?? '', isBot: String(n.author.id) === self.providerUserId }));
    },

    createTopLevelComment: async (
      target: DiscussionTarget,
      body: RichComment,
      idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const projectId = await this.pid(target.ref.repositoryId);
      const base =
        target.kind === 'change-request'
          ? `projects/${projectId}/merge_requests/${target.ref.number}/notes`
          : `projects/${projectId}/issues/${target.ref.number}/notes`;
      // Idempotent retry: reuse the note carrying the marker from a previous attempt.
      const existing = (
        await this.options.client.getAllPages<{ id: number; body: string | null }>(base, {
          query: { per_page: 100 },
        })
      ).find((note) => hasIdempotencyMarker(note.body, idem.key));
      if (existing) return { nativeId: String(existing.id) };
      const res = await this.options.client.post<{ id: number }>(base, {
        body: { body: withIdempotencyMarker(body.markdown, idem.key) },
      });
      return { nativeId: String(res.data.id) };
    },

    createInlineComment: async (
      ref: ChangeRequestRef,
      anchor: ProviderAnchor,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const projectId = await this.pid(ref.repositoryId);
      const mr = await this.getMr(projectId, ref.number);
      const refs = mr.diff_refs ?? { base_sha: '', start_sha: '', head_sha: '' };
      const res = await this.options.client.post<{ id: string; notes: { id: number }[] }>(
        `projects/${projectId}/merge_requests/${ref.number}/discussions`,
        {
          body: {
            body: body.markdown,
            position: {
              base_sha: refs.base_sha,
              start_sha: refs.start_sha,
              head_sha: refs.head_sha,
              position_type: 'text',
              new_path: anchor.path,
              old_path: anchor.path,
              ...(anchor.side === 'head' ? { new_line: anchor.line } : { old_line: anchor.line }),
            },
          },
        },
      );
      return { nativeId: String(res.data.notes[0]?.id ?? res.data.id), threadNativeId: res.data.id };
    },

    reply: async (
      thread: DiscussionThreadRef,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      if (!thread.changeRequest) {
        throw new ProviderError('missing_context', 'reply 需要 thread.changeRequest 上下文');
      }
      const projectId = await this.pid(thread.changeRequest.repositoryId);
      const res = await this.options.client.post<{ id: number }>(
        `projects/${projectId}/merge_requests/${thread.changeRequest.number}/discussions/${thread.nativeId}/notes`,
        { body: { body: body.markdown } },
      );
      return { nativeId: String(res.data.id), threadNativeId: thread.nativeId };
    },

    editComment: async (comment: CommentRef, body: RichComment): Promise<void> => {
      if (!comment.changeRequest) {
        throw new ProviderError('missing_context', 'editComment 需要 comment.changeRequest 上下文');
      }
      const projectId = await this.pid(comment.changeRequest.repositoryId);
      await this.options.client.put(
        `projects/${projectId}/merge_requests/${comment.changeRequest.number}/notes/${comment.nativeId}`,
        { body: { body: body.markdown } },
      );
    },

    resolve: async (thread: DiscussionThreadRef): Promise<void> => {
      if (!thread.changeRequest) {
        throw new ProviderError('missing_context', 'resolve 需要 thread.changeRequest 上下文');
      }
      const projectId = await this.pid(thread.changeRequest.repositoryId);
      await this.options.client.put(
        `projects/${projectId}/merge_requests/${thread.changeRequest.number}/discussions/${thread.nativeId}`,
        { body: { resolved: true } },
      );
    },

    createReviewBatch: async (_ref: ChangeRequestRef, _review: ReviewBatch, _idem: IdempotencyContext): Promise<ReviewReceipt> => {
      throw new UnsupportedCapabilityError('reviewBatches');
    },
  };

  issues = {
    get: async (repo: RepositoryRef, number: number): Promise<IssueContent> => {
      const res = await this.options.client.get<{
        id: number;
        iid: number;
        title: string;
        description: string | null;
        state: string;
        labels: string[];
      }>(`projects/${repo.nativeId}/issues/${number}`);
      return {
        nativeId: String(res.data.id),
        number: res.data.iid,
        title: res.data.title,
        body: res.data.description ?? '',
        state: res.data.state,
        labels: res.data.labels ?? [],
      };
    },

    create: async (
      repo: RepositoryRef,
      input: IssueInput,
      idem: IdempotencyContext,
    ): Promise<IssueReceipt> => {
      // Idempotent retry: look for the marker among issues updated in the last 6 hours
      // (delivery retries happen within minutes).
      const updatedAfter = new Date(this.now() - 6 * 60 * 60_000).toISOString();
      for (let page = 1; page <= 3; page += 1) {
        const listed = await this.options.client.get<
          { id: number; iid: number; web_url?: string; description: string | null }[]
        >(`projects/${repo.nativeId}/issues`, {
          query: {
            state: 'all',
            order_by: 'created_at',
            sort: 'desc',
            updated_after: updatedAfter,
            per_page: 100,
            page,
          },
        });
        const hit = listed.data.find((issue) =>
          hasIdempotencyMarker(issue.description, idem.key),
        );
        if (hit) {
          return {
            ref: {
              id: uuidv7(this.now()),
              repositoryId: repo.id,
              nativeId: String(hit.id),
              number: hit.iid,
            },
            ...(hit.web_url ? { url: hit.web_url } : {}),
          };
        }
        if (listed.data.length < 100) break;
      }
      const res = await this.options.client.post<{ id: number; iid: number; web_url?: string }>(
        `projects/${repo.nativeId}/issues`,
        {
          body: {
            title: input.title,
            description: withIdempotencyMarker(input.body.markdown, idem.key),
            ...(input.labels ? { labels: input.labels.join(',') } : {}),
          },
        },
      );
      return {
        ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(res.data.id), number: res.data.iid },
        ...(res.data.web_url ? { url: res.data.web_url } : {}),
      };
    },

    comment: async (
      ref: IssueRef,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const projectId = await this.pid(ref.repositoryId);
      const res = await this.options.client.post<{ id: number }>(
        `projects/${projectId}/issues/${ref.number}/notes`,
        { body: { body: body.markdown } },
      );
      return { nativeId: String(res.data.id) };
    },
  };

  checks = {
    createOrUpdate: async (
      repo: RepositoryRef,
      input: CheckInput,
      _idem: IdempotencyContext,
    ): Promise<CheckReceipt> => {
      const state = mapCommitStatus(input);
      const res = await this.options.client.post<{ id: number }>(
        `projects/${repo.nativeId}/statuses/${input.headSha}`,
        {
          body: {
            state,
            name: input.name,
            ...(input.detailsUrl ? { target_url: input.detailsUrl } : {}),
            ...(input.summary ? { description: input.summary } : {}),
          },
        },
      );
      return { nativeId: String(res.data.id) };
    },
  };

  // A repeated award returns 404/409; callers treat this as best-effort.
  reactions = {
    addToChangeRequest: async (ref: ChangeRequestRef, content: ReactionContent): Promise<void> => {
      const projectId = await this.pid(ref.repositoryId);
      await this.options.client.post(`projects/${projectId}/merge_requests/${ref.number}/award_emoji`, { body: { name: content } });
    },
    addToIssue: async (ref: IssueRef, content: ReactionContent): Promise<void> => {
      const projectId = await this.pid(ref.repositoryId);
      await this.options.client.post(`projects/${projectId}/issues/${ref.number}/award_emoji`, { body: { name: content } });
    },
  };

  // Run refs carry repositoryId so getJobs/getLogs can resolve the project.
  pipelines = {
    listRuns: async (ref: ChangeRequestRef): Promise<PipelineRun[]> => {
      const projectId = await this.pid(ref.repositoryId);
      const res = await this.options.client.get<{ id: number; status: string; sha: string }[]>(
        `projects/${projectId}/merge_requests/${ref.number}/pipelines`,
      );
      return res.data.map((p) => ({
        ref: { nativeId: String(p.id), repositoryId: ref.repositoryId },
        status: p.status,
        headSha: p.sha,
        ...(GL_TERMINAL.has(p.status) ? { conclusion: p.status } : {}),
      }));
    },
    getJobs: async (run: PipelineRunRef): Promise<PipelineJob[]> => {
      const repositoryId = run.repositoryId;
      if (!repositoryId) throw new ProviderError('invalid_request', 'pipelines.getJobs 需 run.ref.repositoryId');
      const projectId = await this.pid(repositoryId);
      const res = await this.options.client.get<{ id: number; name: string; status: string }[]>(
        `projects/${projectId}/pipelines/${run.nativeId}/jobs`,
        { query: { per_page: 100 } },
      );
      return res.data.map((j) => ({
        ref: { nativeId: String(j.id), repositoryId },
        name: j.name,
        status: j.status,
        ...(GL_TERMINAL.has(j.status) ? { conclusion: j.status } : {}),
      }));
    },
    getLogs: async (job: PipelineJobRef): Promise<PipelineLogs> => {
      if (!job.repositoryId) throw new ProviderError('invalid_request', 'pipelines.getLogs 需 job.ref.repositoryId');
      const projectId = await this.pid(job.repositoryId);
      const res = await this.options.client.get<string>(`projects/${projectId}/jobs/${job.nativeId}/trace`, { raw: true });
      const text = typeof res.data === 'string' ? res.data : '';
      return { text, truncated: false };
    },
  };

  branches = {
    get: async (repo: RepositoryRef, name: string): Promise<BranchRef | null> => {
      try {
        const res = await this.options.client.get<{ commit: { id: string } }>(
          `projects/${repo.nativeId}/repository/branches/${encodeURIComponent(name)}`,
        );
        return { name, sha: res.data.commit.id };
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null;
        throw error;
      }
    },
    create: async (repo: RepositoryRef, input: BranchRef): Promise<BranchRef> => {
      await this.options.client.post(`projects/${repo.nativeId}/repository/branches`, {
        query: { branch: input.name, ref: input.sha },
      });
      return input;
    },
    delete: async (repo: RepositoryRef, name: string): Promise<void> => {
      await this.options.client.delete(
        `projects/${repo.nativeId}/repository/branches/${encodeURIComponent(name)}`,
      );
    },
  };

  webhooks = {
    verify: (raw: RawWebhookDelivery, secret: string): WebhookVerificationResult =>
      verifyGitlabWebhook(raw, secret),
    normalize: (raw: RawWebhookDelivery): ProviderWebhookEvent[] => normalizeGitlabWebhook(raw),
  };

  capabilities = {
    forChangeRequest: async (_ref: ChangeRequestRef): Promise<ChangeRequestCapabilities> =>
      gitlabCapabilities(),
  };
}

function mapCommitStatus(input: CheckInput): string {
  if (input.status === 'queued') return 'pending';
  if (input.status === 'in-progress') return 'running';
  switch (input.conclusion) {
    case 'failure':
    case 'timed-out':
    case 'action-required':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'success';
  }
}
