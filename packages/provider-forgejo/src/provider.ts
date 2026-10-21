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
  type PathCommitAuthor,
  type RepositoryPermission,
  type CheckInput,
  type CheckReceipt,
  type ReactionContent,
  type Commit,
  type CommentReceipt,
  type CommentRef,
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
import { forgejoCapabilities } from './capabilities.js';
import { normalizeForgejoWebhook, verifyForgejoWebhook } from './webhook.js';

export interface FjRepoCoords {
  owner: string;
  repo: string;
}

export interface ForgejoProviderOptions {
  client: RestClient;
  host: ProviderHostRef;
  resolveRepo: (repositoryId: string) => FjRepoCoords | Promise<FjRepoCoords>;
  now?: () => number;
}

interface FjUserResp {
  id: number;
  login?: string;
  username?: string;
}
interface FjPullResp {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  draft?: boolean;
  mergeable?: boolean;
  merge_base?: string;
  user: FjUserResp;
  head: { sha: string; ref: string; repo?: { id: number; private?: boolean } | null };
  base: { sha: string; ref: string; repo?: { id: number } | null };
  labels?: { name: string }[];
  /** Users who already submitted a review are removed from this list. */
  requested_reviewers?: FjUserResp[] | null;
}

function toActor(user: FjUserResp): Actor {
  return { providerUserId: String(user.id), login: user.login ?? user.username ?? '', type: 'user' };
}

export class ForgejoProvider implements SourceControlProvider {
  readonly kind = 'forgejo' as const;

  constructor(private readonly options: ForgejoProviderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private coords(repositoryId: string): Promise<FjRepoCoords> {
    return Promise.resolve(this.options.resolveRepo(repositoryId));
  }

  private async getPull(c: FjRepoCoords, index: number): Promise<FjPullResp> {
    const res = await this.options.client.get<FjPullResp>(`repos/${c.owner}/${c.repo}/pulls/${index}`);
    return res.data;
  }

  private buildRevision(ref: ChangeRequestRef, pull: FjPullResp): Revision {
    return {
      id: uuidv7(this.now()),
      changeRequestId: ref.id,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeBaseSha: pull.merge_base ?? pull.base.sha,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  identity = {
    botActor: async (): Promise<Actor> => {
      const res = await this.options.client.get<FjUserResp>('user');
      return toActor(res.data);
    },

    /** The bot is a regular account; with email privacy on, this returns the instance noreply address. */
    commitIdentity: async (): Promise<GitCommitIdentity | null> => {
      const res = await this.options.client.get<FjUserResp & { email?: string; full_name?: string }>('user');
      if (!res.data.email) return null;
      const login = res.data.login ?? res.data.username ?? '';
      return { name: res.data.full_name?.trim() || login, email: res.data.email };
    },
  };

  /** Forgejo/Gitea have no user.type=Bot, so isBot compares author ids against this. */
  private selfActorP?: Promise<Actor>;
  private botActorCached(): Promise<Actor> {
    return (this.selfActorP ??= this.identity.botActor());
  }

  repositories = {
    get: async (ref: RepositoryRef): Promise<RepositoryRef> => {
      await this.options.client.get(`repos/${ref.namespace}/${ref.name}`);
      return ref;
    },
    listForInstallation: async (_installationId: string): Promise<RepositoryRef[]> => [],
    /** Contents API (base64, like GitHub); ref defaults to the default branch; 404 -> null. */
    getFileContent: async (ref: RepositoryRef, path: string, gitRef?: string): Promise<string | null> => {
      try {
        const res = await this.options.client.get<{ content?: string; encoding?: string }>(
          `repos/${ref.namespace}/${ref.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
          { query: gitRef ? { ref: gitRef } : {} },
        );
        if (typeof res.data.content !== 'string') return null;
        return Buffer.from(res.data.content, 'base64').toString('utf8');
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return null;
        throw error;
      }
    },
    // Forgejo/Gitea only have admin/write/read/none; a non-collaborator gets 404 -> none.
    getActorPermission: async (ref: RepositoryRef, actor: { login: string }): Promise<RepositoryPermission> => {
      try {
        const res = await this.options.client.get<{ permission?: string }>(
          `repos/${ref.namespace}/${ref.name}/collaborators/${encodeURIComponent(actor.login)}/permission`,
        );
        switch ((res.data.permission ?? 'none').toLowerCase()) {
          case 'owner':
          case 'admin':
            return 'admin';
          case 'write':
            return 'write';
          case 'read':
            return 'read';
          default:
            return 'none';
        }
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return 'none';
        throw error;
      }
    },

    // author is null when the commit email is not linked to an account.
    listPathCommitAuthors: async (
      ref: RepositoryRef,
      path: string,
      opts: { gitRef: string; limit: number },
    ): Promise<PathCommitAuthor[]> => {
      const res = await this.options.client.get<{ author: FjUserResp | null; commit: { author?: { date?: string } } }[]>(
        `repos/${ref.namespace}/${ref.name}/commits`,
        { query: { path, sha: opts.gitRef, limit: opts.limit, stat: false, files: false, verification: false } },
      );
      return res.data.flatMap((c) =>
        c.author && c.commit.author?.date ? [{ actor: toActor(c.author), committedAt: c.commit.author.date }] : [],
      );
    },
  };

  changes = {
    get: async (ref: ChangeRequestRef): Promise<ChangeRequest> => {
      const c = await this.coords(ref.repositoryId);
      const pull = await this.getPull(c, ref.number);
      const isFork =
        pull.head.repo != null && pull.base.repo != null && pull.head.repo.id !== pull.base.repo.id;
      const state: ChangeRequest['state'] = pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open';
      return {
        // The forge's own id, as webhooks report it: callers may only know the number.
        ref: { ...ref, nativeId: String(pull.id) },
        revision: this.buildRevision(ref, pull),
        title: pull.title,
        description: pull.body ?? '',
        state,
        draft: pull.draft ?? false,
        author: toActor(pull.user),
        labels: (pull.labels ?? []).map((l) => l.name),
        reviewers: (pull.requested_reviewers ?? []).map(toActor),
        linkedIssues: [],
        mergeability: pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown',
        trust: isFork ? (pull.head.repo?.private ? 'fork-private' : 'fork-public') : 'same-repo-trusted',
        capabilities: forgejoCapabilities(),
      };
    },

    getRevision: async (ref: ChangeRequestRef): Promise<Revision> => {
      const c = await this.coords(ref.repositoryId);
      return this.buildRevision(ref, await this.getPull(c, ref.number));
    },

    getDescription: async (ref: ChangeRequestRef): Promise<string> => {
      const c = await this.coords(ref.repositoryId);
      const pull = await this.getPull(c, ref.number);
      return pull.body ?? '';
    },

    updateDescription: async (ref: ChangeRequestRef, body: string): Promise<void> => {
      const c = await this.coords(ref.repositoryId);
      await this.options.client.patch(`repos/${c.owner}/${c.repo}/pulls/${ref.number}`, { body: { body } });
    },

    listCommits: async (ref: ChangeRequestRef): Promise<Commit[]> => {
      const c = await this.coords(ref.repositoryId);
      const commits = await this.options.client.getAllPages<
        { sha: string; commit: { message: string; author?: { date?: string } }; parents?: { sha: string }[] }
      >(`repos/${c.owner}/${c.repo}/pulls/${ref.number}/commits`, { query: { limit: 50 } });
      return commits.map((x) => ({
        sha: x.sha,
        message: x.commit.message,
        ...(x.commit.author?.date ? { authoredAt: x.commit.author.date } : {}),
        parents: (x.parents ?? []).map((p) => p.sha),
      }));
    },

    listChangedFiles: async (ref: ChangeRequestRef): Promise<ChangedFile[]> => {
      const c = await this.coords(ref.repositoryId);
      const files = await this.options.client.getAllPages<
        { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number }
      >(`repos/${c.owner}/${c.repo}/pulls/${ref.number}/files`, { query: { limit: 50 } });
      return files.map((f) => ({
        ...(f.previous_filename ? { oldPath: f.previous_filename } : { oldPath: f.filename }),
        newPath: f.filename,
        status:
          f.status === 'added'
            ? 'added'
            : f.status === 'deleted' || f.status === 'removed'
              ? 'deleted'
              : f.status === 'renamed'
                ? 'renamed'
                : 'modified',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
    },

    getProviderDiff: async (ref: ChangeRequestRef): Promise<ProviderDiff> => {
      const c = await this.coords(ref.repositoryId);
      const res = await this.options.client.get<string>(
        `repos/${c.owner}/${c.repo}/pulls/${ref.number}.diff`,
        { accept: 'text/plain', raw: true },
      );
      return { raw: res.data, truncated: false };
    },

    requestReviewers: async (ref: ChangeRequestRef, reviewers: Actor[]): Promise<void> => {
      const c = await this.coords(ref.repositoryId);
      await this.options.client.post(`repos/${c.owner}/${c.repo}/pulls/${ref.number}/requested_reviewers`, {
        body: { reviewers: reviewers.map((r) => r.login) },
      });
    },

    listReviews: async (ref: ChangeRequestRef): Promise<ReviewRecord[]> => {
      const c = await this.coords(ref.repositoryId);
      const reviews = await this.options.client.getAllPages<
        { id: number; user: FjUserResp; state: string; submitted_at?: string }
      >(`repos/${c.owner}/${c.repo}/pulls/${ref.number}/reviews`, { query: { limit: 50 } });
      return reviews.map((r) => ({
        nativeId: String(r.id),
        author: toActor(r.user),
        state: mapReviewState(r.state),
        ...(r.submitted_at ? { submittedAt: r.submitted_at } : {}),
      }));
    },

    create: async (
      repo: RepositoryRef,
      input: CreateChangeRequestInput,
      _idem: IdempotencyContext,
    ): Promise<ChangeRequestReceipt> => {
      // Idempotent by source branch (a second delivery of the same stacked branch updates its PR).
      // Forgejo's list API has no head filter: the open pull requests are matched here.
      const open = await this.options.client.getAllPages<{ id: number; number: number; html_url?: string; head?: { ref?: string } }>(
        `repos/${repo.namespace}/${repo.name}/pulls`,
        { query: { state: 'open', limit: 50 } },
      );
      const existing = open.find((pr) => pr.head?.ref === input.sourceBranch);
      if (existing) {
        await this.options.client.patch(`repos/${repo.namespace}/${repo.name}/pulls/${existing.number}`, {
          body: { title: input.title, body: input.body.markdown },
        });
        return {
          ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(existing.id), number: existing.number, kind: 'pull-request' },
          ...(existing.html_url ? { url: existing.html_url } : {}),
        };
      }
      const res = await this.options.client.post<{ id: number; number: number; html_url?: string }>(
        `repos/${repo.namespace}/${repo.name}/pulls`,
        { body: { title: input.title, head: input.sourceBranch, base: input.targetBranch, body: input.body.markdown } },
      );
      return {
        ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(res.data.id), number: res.data.number, kind: 'pull-request' },
        ...(res.data.html_url ? { url: res.data.html_url } : {}),
      };
    },
  };

  discussions = {
    listThreads: async (target: DiscussionTarget): Promise<DiscussionThread[]> => {
      if (target.kind !== 'change-request') return [];
      const c = await this.coords(target.ref.repositoryId);
      const comments = await this.options.client.getAllPages<
        { id: number; user: FjUserResp; body: string; created_at: string }
      >(`repos/${c.owner}/${c.repo}/pulls/${target.ref.number}/comments`, { query: { limit: 50 } });
      return comments.map((cm) => ({
        ref: { nativeId: String(cm.id), changeRequest: target.ref },
        resolved: false,
        comments: [
          { nativeId: String(cm.id), author: toActor(cm.user), body: cm.body, createdAt: cm.created_at, isBot: false },
        ],
      }));
    },

    listTopLevelComments: async (target: DiscussionTarget): Promise<TopLevelComment[]> => {
      const c = await this.coords(target.ref.repositoryId);
      const self = await this.botActorCached();
      // PR and issue top-level comments share issues/{n}/comments.
      const comments = await this.options.client.getAllPages<{ id: number; body: string; user: FjUserResp }>(
        `repos/${c.owner}/${c.repo}/issues/${target.ref.number}/comments`,
        { query: { limit: 50 } },
      );
      return comments.map((cm) => ({ nativeId: String(cm.id), body: cm.body ?? '', isBot: String(cm.user.id) === self.providerUserId }));
    },

    createTopLevelComment: async (
      target: DiscussionTarget,
      body: RichComment,
      idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const c = await this.coords(target.ref.repositoryId);
      // Idempotent retry: reuse the comment carrying the marker from a previous attempt.
      const existing = (
        await this.options.client.getAllPages<{ id: number; html_url?: string; body: string | null }>(
          `repos/${c.owner}/${c.repo}/issues/${target.ref.number}/comments`,
          { query: { limit: 100 } },
        )
      ).find((comment) => hasIdempotencyMarker(comment.body, idem.key));
      if (existing)
        return {
          nativeId: String(existing.id),
          ...(existing.html_url ? { url: existing.html_url } : {}),
        };
      const res = await this.options.client.post<{ id: number; html_url?: string }>(
        `repos/${c.owner}/${c.repo}/issues/${target.ref.number}/comments`,
        { body: { body: withIdempotencyMarker(body.markdown, idem.key) } },
      );
      return { nativeId: String(res.data.id), ...(res.data.html_url ? { url: res.data.html_url } : {}) };
    },

    createInlineComment: async (
      ref: ChangeRequestRef,
      anchor: ProviderAnchor,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const c = await this.coords(ref.repositoryId);
      const res = await this.options.client.post<{ id: number }>(
        `repos/${c.owner}/${c.repo}/pulls/${ref.number}/reviews`,
        {
          body: {
            event: 'COMMENT',
            body: '',
            comments: [
              {
                path: anchor.path,
                body: body.markdown,
                ...(anchor.side === 'head' ? { new_position: anchor.line } : { old_position: anchor.line }),
              },
            ],
          },
        },
      );
      return { nativeId: String(res.data.id) };
    },

    reply: async (
      thread: DiscussionThreadRef,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      if (!thread.changeRequest) {
        throw new ProviderError('missing_context', 'reply 需要 thread.changeRequest 上下文');
      }
      const c = await this.coords(thread.changeRequest.repositoryId);
      const res = await this.options.client.post<{ id: number }>(
        `repos/${c.owner}/${c.repo}/issues/${thread.changeRequest.number}/comments`,
        { body: { body: body.markdown } },
      );
      return { nativeId: String(res.data.id), threadNativeId: thread.nativeId };
    },

    editComment: async (comment: CommentRef, body: RichComment): Promise<void> => {
      if (!comment.changeRequest) {
        throw new ProviderError('missing_context', 'editComment 需要 comment.changeRequest 上下文');
      }
      const c = await this.coords(comment.changeRequest.repositoryId);
      await this.options.client.patch(`repos/${c.owner}/${c.repo}/issues/comments/${comment.nativeId}`, {
        body: { body: body.markdown },
      });
    },

    resolve: async (_thread: DiscussionThreadRef): Promise<void> => {
      throw new UnsupportedCapabilityError('resolvableThreads');
    },
    createReviewBatch: async (_ref: ChangeRequestRef, _review: ReviewBatch, _idem: IdempotencyContext): Promise<ReviewReceipt> => {
      throw new UnsupportedCapabilityError('reviewBatches');
    },
  };

  issues = {
    get: async (repo: RepositoryRef, number: number): Promise<IssueContent> => {
      const res = await this.options.client.get<{
        id: number;
        number: number;
        title: string;
        body: string | null;
        state: string;
        labels: ({ name: string } | string)[] | null;
      }>(`repos/${repo.namespace}/${repo.name}/issues/${number}`);
      return {
        nativeId: String(res.data.id),
        number: res.data.number,
        title: res.data.title,
        body: res.data.body ?? '',
        state: res.data.state,
        labels: (res.data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      };
    },

    create: async (
      repo: RepositoryRef,
      input: IssueInput,
      idem: IdempotencyContext,
    ): Promise<IssueReceipt> => {
      // Idempotent retry: look for the marker among issues updated in the last 6 hours
      // (delivery retries happen within minutes).
      const since = new Date(this.now() - 6 * 60 * 60_000).toISOString();
      for (let page = 1; page <= 3; page += 1) {
        const listed = await this.options.client.get<
          { id: number; number: number; html_url?: string; body: string | null }[]
        >(`repos/${repo.namespace}/${repo.name}/issues`, {
          query: { state: 'all', type: 'issues', since, limit: 100, page },
        });
        const hit = listed.data.find((issue) => hasIdempotencyMarker(issue.body, idem.key));
        if (hit) {
          return {
            ref: {
              id: uuidv7(this.now()),
              repositoryId: repo.id,
              nativeId: String(hit.id),
              number: hit.number,
            },
            ...(hit.html_url ? { url: hit.html_url } : {}),
          };
        }
        if (listed.data.length < 100) break;
      }
      const res = await this.options.client.post<{ id: number; number: number; html_url?: string }>(
        `repos/${repo.namespace}/${repo.name}/issues`,
        {
          body: {
            title: input.title,
            body: withIdempotencyMarker(input.body.markdown, idem.key),
            ...(input.labels ? { labels: input.labels } : {}),
          },
        },
      );
      return {
        ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(res.data.id), number: res.data.number },
        ...(res.data.html_url ? { url: res.data.html_url } : {}),
      };
    },

    comment: async (
      ref: IssueRef,
      body: RichComment,
      _idem: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const c = await this.coords(ref.repositoryId);
      const res = await this.options.client.post<{ id: number }>(
        `repos/${c.owner}/${c.repo}/issues/${ref.number}/comments`,
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
      const res = await this.options.client.post<{ id: number }>(
        `repos/${repo.namespace}/${repo.name}/statuses/${input.headSha}`,
        {
          body: {
            state: mapCommitStatus(input),
            context: input.name,
            ...(input.summary ? { description: input.summary } : {}),
            ...(input.detailsUrl ? { target_url: input.detailsUrl } : {}),
          },
        },
      );
      return { nativeId: String(res.data.id) };
    },
  };

  // A repeated reaction returns 200, so this is idempotent.
  reactions = {
    addToChangeRequest: async (ref: ChangeRequestRef, content: ReactionContent): Promise<void> => {
      const c = await this.coords(ref.repositoryId);
      await this.options.client.post(`repos/${c.owner}/${c.repo}/issues/${ref.number}/reactions`, { body: { content } });
    },
    addToIssue: async (ref: IssueRef, content: ReactionContent): Promise<void> => {
      const c = await this.coords(ref.repositoryId);
      await this.options.client.post(`repos/${c.owner}/${c.repo}/issues/${ref.number}/reactions`, { body: { content } });
    },
  };

  pipelines = {
    listRuns: (_ref: ChangeRequestRef): Promise<PipelineRun[]> => {
      throw new ProviderError('not_implemented', 'pipelines 属 M8 范围(Forgejo Actions)');
    },
    getJobs: (_run: PipelineRunRef): Promise<PipelineJob[]> => {
      throw new ProviderError('not_implemented', 'pipelines 属 M8 范围');
    },
    getLogs: (_job: PipelineJobRef): Promise<PipelineLogs> => {
      throw new ProviderError('not_implemented', 'pipelines 属 M8 范围');
    },
  };

  branches = {
    get: async (repo: RepositoryRef, name: string): Promise<BranchRef | null> => {
      try {
        const res = await this.options.client.get<{ commit: { id: string } }>(
          `repos/${repo.namespace}/${repo.name}/branches/${encodeURIComponent(name)}`,
        );
        return { name, sha: res.data.commit.id };
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null;
        throw error;
      }
    },
    create: async (repo: RepositoryRef, input: BranchRef): Promise<BranchRef> => {
      await this.options.client.post(`repos/${repo.namespace}/${repo.name}/branches`, {
        body: { new_branch_name: input.name, old_ref_name: input.sha },
      });
      return input;
    },
    delete: async (repo: RepositoryRef, name: string): Promise<void> => {
      await this.options.client.delete(
        `repos/${repo.namespace}/${repo.name}/branches/${encodeURIComponent(name)}`,
      );
    },
  };

  webhooks = {
    verify: (raw: RawWebhookDelivery, secret: string): WebhookVerificationResult =>
      verifyForgejoWebhook(raw, secret),
    normalize: (raw: RawWebhookDelivery): ProviderWebhookEvent[] => normalizeForgejoWebhook(raw),
  };

  capabilities = {
    forChangeRequest: async (_ref: ChangeRequestRef): Promise<ChangeRequestCapabilities> =>
      forgejoCapabilities(),
  };
}

function mapCommitStatus(input: CheckInput): string {
  if (input.status !== 'completed') return 'pending';
  switch (input.conclusion) {
    case 'failure':
    case 'timed-out':
      return 'failure';
    case 'cancelled':
      return 'error';
    case 'action-required':
      return 'warning';
    default:
      return 'success';
  }
}

function mapReviewState(state: string): ReviewRecord['state'] {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'REQUEST_CHANGES':
      return 'changes-requested';
    case 'PENDING':
      return 'pending';
    default:
      return 'commented';
  }
}
