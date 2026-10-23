import {
  botName,
  type Actor,
  type ChangeRequest,
  type ChangeRequestCapabilities,
  type ChangeRequestRef,
  type IssueRef,
  type ProviderHostRef,
  type RepositoryRef,
  type Revision,
} from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import {
  ProviderError,
  type BranchRef,
  type ChangeRequestReceipt,
  type CommitApi,
  type CreateChangeRequestInput,
  type ChangedFile,
  type PathCommitAuthor,
  type RepositoryPermission,
  type CheckInput,
  type CheckReceipt,
  type Commit,
  type CommentReceipt,
  type CommentRef,
  type DiscussionTarget,
  type DiscussionThread,
  type DiscussionThreadRef,
  type GitCommitIdentity,
  type IdempotencyContext,
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
  type ReactionContent,
  type ReviewBatch,
  type ReviewReceipt,
  type ReviewRecord,
  type RichComment,
  type SourceControlProvider,
  type TopLevelComment,
  type WebhookVerificationResult,
  hasIdempotencyMarker,
  withIdempotencyMarker,
} from '@reviewbot/provider-contracts';
import type { RestClient } from '@reviewbot/provider-http';
import { githubCapabilities } from './capabilities.js';
import { normalizeGithubWebhook } from './normalize.js';
import { verifyGithubWebhook } from './webhook-verify.js';

export interface GhRepoCoords {
  owner: string;
  repo: string;
}

export interface GithubProviderOptions {
  client: RestClient;
  host: ProviderHostRef;
  resolveRepo: (repositoryId: string) => GhRepoCoords | Promise<GhRepoCoords>;
  /** Used to find the bot account `<slug>[bot]`; falls back to env `GITHUB_APP_SLUG`, then `BOT_NAME`. */
  appSlug?: string;
  now?: () => number;
}

interface GhUserResp {
  id: number;
  login: string;
  type?: string;
}
interface GhPullResp {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  labels?: { name: string }[];
  user: GhUserResp;
  /** Users still pending review (GitHub drops those who reviewed; teams are not included). */
  requested_reviewers?: GhUserResp[];
  head: { sha: string; ref: string; repo: { id: number; private: boolean } | null };
  base: { sha: string; ref: string; repo: { id: number } };
}

function toActor(user: GhUserResp): Actor {
  return {
    providerUserId: String(user.id),
    login: user.login,
    type: user.type === 'Bot' ? 'bot' : 'user',
  };
}

function side(anchorSide: 'base' | 'head'): 'LEFT' | 'RIGHT' {
  return anchorSide === 'base' ? 'LEFT' : 'RIGHT';
}

export class GithubProvider implements SourceControlProvider {
  readonly kind = 'github' as const;

  constructor(private readonly options: GithubProviderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private coords(repositoryId: string): Promise<GhRepoCoords> {
    return Promise.resolve(this.options.resolveRepo(repositoryId));
  }

  private async getPull(coords: GhRepoCoords, number: number): Promise<GhPullResp> {
    const res = await this.options.client.get<GhPullResp>(
      `repos/${coords.owner}/${coords.repo}/pulls/${number}`,
    );
    return res.data;
  }

  /** GraphQL errors are thrown as ProviderError. */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.options.client.post<{ data?: T; errors?: { message: string }[] }>('graphql', {
      body: { query, variables },
    });
    if (res.data.errors?.length) {
      throw new ProviderError('provider_error', `GitHub GraphQL: ${res.data.errors.map((e) => e.message).join('; ')}`);
    }
    if (!res.data.data) throw new ProviderError('provider_error', 'GitHub GraphQL 返回无 data');
    return res.data.data;
  }

  /**
   * Maps a thread's top comment databaseId (our nativeId) to the GraphQL thread node id that
   * resolveReviewThread needs; null when not found. Only the first 100 threads × 100 comments are scanned.
   */
  private async reviewThreadNodeId(thread: DiscussionThreadRef): Promise<string | null> {
    if (!thread.changeRequest) throw new ProviderError('missing_context', 'resolve 需要 thread.changeRequest 上下文');
    const coords = await this.coords(thread.changeRequest.repositoryId);
    const targetId = Number(thread.nativeId);
    const data = await this.graphql<{
      repository: { pullRequest: { reviewThreads: { nodes: { id: string; comments: { nodes: { databaseId: number }[] } }[] } } } | null;
    }>(
      `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id comments(first:100){nodes{databaseId}}}}}}}`,
      { owner: coords.owner, repo: coords.repo, number: thread.changeRequest.number },
    );
    const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.find((t) => t.comments.nodes.some((c) => c.databaseId === targetId))?.id ?? null;
  }

  identity = {
    /**
     * `GET /user` is 403 for an installation token (an App has no user), so look up `<slug>[bot]`
     * first and fall back to `GET /user` (PAT deployments, wrong slug).
     */
    botActor: async (): Promise<Actor> => {
      const slug = this.appSlug();
      if (slug) {
        const bot = await this.options.client
          .get<GhUserResp>(`users/${encodeURIComponent(`${slug}[bot]`)}`)
          .catch(() => null);
        if (bot) return toActor(bot.data);
      }
      const res = await this.options.client.get<GhUserResp>('user');
      return toActor(res.data);
    },

    /** GitHub links bot commits only via `<user id>+<login>@users.noreply.github.com`. */
    commitIdentity: async (): Promise<GitCommitIdentity | null> => {
      const actor = await this.botActorCached().catch(() => null);
      if (!actor) return null;
      return {
        name: actor.login,
        email: `${actor.providerUserId}+${actor.login}@users.noreply.github.com`,
      };
    },
  };

  private selfActorP: Promise<Actor> | undefined;
  private botActorCached(): Promise<Actor> {
    // Failures are not cached, so one 5xx does not stick for the process lifetime.
    return (this.selfActorP ??= this.identity.botActor().catch((err: unknown) => {
      this.selfActorP = undefined;
      throw err;
    }));
  }

  private appSlug(): string | undefined {
    const slug = this.options.appSlug ?? process.env.GITHUB_APP_SLUG ?? botName();
    return slug.trim() || undefined;
  }

  repositories = {
    get: async (ref: RepositoryRef): Promise<RepositoryRef> => {
      await this.options.client.get(`repos/${ref.namespace}/${ref.name}`);
      return ref;
    },
    listForInstallation: async (installationId: string): Promise<RepositoryRef[]> => {
      // Page through everything, stopping on total_count; capped at 50 pages as a loop guard.
      type GhRepo = { id: number; name: string; default_branch: string; clone_url: string; private?: boolean; owner: { login: string } };
      const all: GhRepo[] = [];
      const PER_PAGE = 100;
      for (let page = 1; page <= 50; page += 1) {
        const res = await this.options.client.get<{ total_count?: number; repositories: GhRepo[] }>(
          'installation/repositories',
          { query: { per_page: PER_PAGE, page } },
        );
        const batch = res.data.repositories ?? [];
        all.push(...batch);
        const total = res.data.total_count;
        if (batch.length < PER_PAGE || (total !== undefined && all.length >= total) || batch.length === 0) break;
      }
      return all.map((r) => ({
        id: uuidv7(this.now()),
        providerHostId: this.options.host.id,
        installationId,
        nativeId: String(r.id),
        namespace: r.owner.login,
        name: r.name,
        cloneUrl: r.clone_url,
        // Missing stays unknown rather than public: billing must not discount on a guess.
        ...(typeof r.private === 'boolean' ? { visibility: r.private ? ('private' as const) : ('public' as const) } : {}),
        defaultBranch: r.default_branch,
      }));
    },
    // 404 (file or ref missing) → null.
    getFileContent: async (ref: RepositoryRef, path: string, gitRef?: string): Promise<string | null> => {
      try {
        const res = await this.options.client.get<{ content?: string; encoding?: string }>(
          `repos/${ref.namespace}/${ref.name}/contents/${path}`,
          { query: gitRef ? { ref: gitRef } : {} },
        );
        if (typeof res.data.content !== 'string') return null;
        return Buffer.from(res.data.content, 'base64').toString('utf8');
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return null;
        throw error;
      }
    },
    // Prefer `role_name` (has maintain/triage) over `permission`; non-collaborators 404 → none.
    // Needs only the default Metadata: Read App permission.
    getActorPermission: async (ref: RepositoryRef, actor: { login: string }): Promise<RepositoryPermission> => {
      try {
        const res = await this.options.client.get<{ permission?: string; role_name?: string }>(
          `repos/${ref.namespace}/${ref.name}/collaborators/${actor.login}/permission`,
        );
        const role = res.data.role_name ?? res.data.permission ?? 'none';
        switch (role.toLowerCase()) {
          case 'admin':
            return 'admin';
          case 'maintain':
            return 'maintain';
          case 'write':
          case 'push':
            return 'write';
          case 'triage':
            return 'triage';
          case 'read':
          case 'pull':
            return 'read';
          default:
            return 'none';
        }
      } catch (error) {
        if ((error as { status?: number })?.status === 404) return 'none';
        throw error;
      }
    },

    // A null author means the commit email maps to no GitHub account; skip it.
    listPathCommitAuthors: async (
      ref: RepositoryRef,
      path: string,
      opts: { gitRef: string; limit: number },
    ): Promise<PathCommitAuthor[]> => {
      const res = await this.options.client.get<{ author: GhUserResp | null; commit: { author: { date: string } | null } }[]>(
        `repos/${ref.namespace}/${ref.name}/commits`,
        { query: { path, sha: opts.gitRef, per_page: opts.limit } },
      );
      return res.data.flatMap((c) =>
        c.author && c.commit.author ? [{ actor: toActor(c.author), committedAt: c.commit.author.date }] : [],
      );
    },
  };

  changes = {
    get: async (ref: ChangeRequestRef): Promise<ChangeRequest> => {
      const coords = await this.coords(ref.repositoryId);
      const pull = await this.getPull(coords, ref.number);
      const revision = await this.buildRevision(ref, coords, pull);
      const isFork = pull.head.repo !== null && pull.head.repo.id !== pull.base.repo.id;
      const state: ChangeRequest['state'] = pull.merged
        ? 'merged'
        : pull.state === 'closed'
          ? 'closed'
          : 'open';
      return {
        // The forge's own id, as webhooks report it: callers may only know the number.
        ref: { ...ref, nativeId: String(pull.id) },
        revision,
        title: pull.title,
        description: pull.body ?? '',
        state,
        draft: pull.draft ?? false,
        author: toActor(pull.user),
        labels: (pull.labels ?? []).map((l) => l.name),
        reviewers: (pull.requested_reviewers ?? []).map(toActor),
        linkedIssues: [],
        mergeability:
          pull.mergeable === true ? 'mergeable' : pull.mergeable === false ? 'conflicting' : 'unknown',
        trust: isFork
          ? pull.head.repo?.private
            ? 'fork-private'
            : 'fork-public'
          : 'same-repo-trusted',
        capabilities: githubCapabilities(),
      };
    },

    getRevision: async (ref: ChangeRequestRef): Promise<Revision> => {
      const coords = await this.coords(ref.repositoryId);
      const pull = await this.getPull(coords, ref.number);
      return this.buildRevision(ref, coords, pull);
    },

    getDescription: async (ref: ChangeRequestRef): Promise<string> => {
      const coords = await this.coords(ref.repositoryId);
      const pull = await this.getPull(coords, ref.number);
      return pull.body ?? '';
    },

    updateDescription: async (ref: ChangeRequestRef, body: string): Promise<void> => {
      const coords = await this.coords(ref.repositoryId);
      await this.options.client.patch(`repos/${coords.owner}/${coords.repo}/pulls/${ref.number}`, { body: { body } });
    },

    listCommits: async (ref: ChangeRequestRef): Promise<Commit[]> => {
      const coords = await this.coords(ref.repositoryId);
      const commits = await this.options.client.getAllPages<
        { sha: string; commit: { message: string; author?: { name?: string; date?: string } }; parents: { sha: string }[] }
      >(`repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/commits`, { query: { per_page: 100 } });
      return commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        ...(c.commit.author?.date ? { authoredAt: c.commit.author.date } : {}),
        parents: c.parents.map((p) => p.sha),
      }));
    },

    listChangedFiles: async (ref: ChangeRequestRef): Promise<ChangedFile[]> => {
      const coords = await this.coords(ref.repositoryId);
      const files = await this.options.client.getAllPages<
        { filename: string; previous_filename?: string; status: string; additions: number; deletions: number }
      >(`repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/files`, { query: { per_page: 100 } });
      return files.map((f) => mapChangedFile(f));
    },

    getProviderDiff: async (ref: ChangeRequestRef): Promise<ProviderDiff> => {
      const coords = await this.coords(ref.repositoryId);
      const res = await this.options.client.get<string>(
        `repos/${coords.owner}/${coords.repo}/pulls/${ref.number}`,
        { accept: 'application/vnd.github.v3.diff', raw: true },
      );
      return { raw: res.data, truncated: false };
    },

    listReviews: async (ref: ChangeRequestRef): Promise<ReviewRecord[]> => {
      const coords = await this.coords(ref.repositoryId);
      const reviews = await this.options.client.getAllPages<
        { id: number; user: GhUserResp; state: string; submitted_at?: string }
      >(`repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/reviews`, { query: { per_page: 100 } });
      return reviews.map((r) => ({
        nativeId: String(r.id),
        author: toActor(r.user),
        state: mapReviewState(r.state),
        ...(r.submitted_at ? { submittedAt: r.submitted_at } : {}),
      }));
    },

    requestReviewers: async (ref: ChangeRequestRef, reviewers: Actor[]): Promise<void> => {
      const coords = await this.coords(ref.repositoryId);
      await this.options.client.post(`repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/requested_reviewers`, {
        body: { reviewers: reviewers.map((r) => r.login) },
      });
    },

    create: async (
      repo: RepositoryRef,
      input: CreateChangeRequestInput,
      _idempotency: IdempotencyContext,
    ): Promise<ChangeRequestReceipt> => {
      // Idempotent by source branch: a redelivery finds its PR already open (GitHub would 422), so
      // that one is updated and returned.
      const open = await this.options.client.get<{ id: number; number: number; html_url?: string }[]>(
        `repos/${repo.namespace}/${repo.name}/pulls`,
        { query: { head: `${repo.namespace}:${input.sourceBranch}`, state: 'open', per_page: 1 } },
      );
      const existing = open.data[0];
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
        {
          body: {
            title: input.title,
            head: input.sourceBranch,
            base: input.targetBranch,
            body: input.body.markdown,
            draft: input.draft ?? false,
          },
        },
      );
      return {
        ref: { id: uuidv7(this.now()), repositoryId: repo.id, nativeId: String(res.data.id), number: res.data.number, kind: 'pull-request' },
        ...(res.data.html_url ? { url: res.data.html_url } : {}),
      };
    },
  };

  private async buildRevision(
    ref: ChangeRequestRef,
    coords: GhRepoCoords,
    pull: GhPullResp,
  ): Promise<Revision> {
    const compare = await this.options.client.get<{ merge_base_commit: { sha: string } }>(
      `repos/${coords.owner}/${coords.repo}/compare/${pull.base.sha}...${pull.head.sha}`,
    );
    return {
      id: uuidv7(this.now()),
      changeRequestId: ref.id,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      mergeBaseSha: compare.data.merge_base_commit.sha,
      sourceBranch: pull.head.ref,
      targetBranch: pull.base.ref,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  discussions = {
    listThreads: async (target: DiscussionTarget): Promise<DiscussionThread[]> => {
      if (target.kind !== 'change-request') return [];
      const coords = await this.coords(target.ref.repositoryId);
      const comments = await this.options.client.getAllPages<
        { id: number; user: GhUserResp; body: string; created_at: string; path: string; line?: number }
      >(`repos/${coords.owner}/${coords.repo}/pulls/${target.ref.number}/comments`, { query: { per_page: 100 } });
      return comments.map((c) => ({
        ref: { nativeId: String(c.id), changeRequest: target.ref },
        resolved: false,
        // Outdated comments may lack `line`; then the anchor is omitted and matching falls back to path.
        ...(c.path && c.line !== undefined ? { anchor: { path: c.path, side: 'head' as const, line: c.line } } : {}),
        comments: [
          {
            nativeId: String(c.id),
            author: toActor(c.user),
            body: c.body,
            createdAt: c.created_at,
            isBot: c.user.type === 'Bot',
          },
        ],
      }));
    },

    listTopLevelComments: async (target: DiscussionTarget): Promise<TopLevelComment[]> => {
      const repositoryId = target.ref.repositoryId;
      const number = target.ref.number;
      const coords = await this.coords(repositoryId);
      // Fetch all pages: on busy PRs the bot's comment may not be on the first page.
      const comments = await this.options.client.getAllPages<{ id: number; user: GhUserResp; body: string }>(
        `repos/${coords.owner}/${coords.repo}/issues/${number}/comments`,
        { query: { per_page: 100 } },
      );
      return comments.map((c) => ({
        nativeId: String(c.id),
        body: c.body ?? '',
        isBot: c.user?.type === 'Bot',
      }));
    },

    createTopLevelComment: async (
      target: DiscussionTarget,
      body: RichComment,
      idempotency: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const repositoryId = target.ref.repositoryId;
      const number = target.kind === 'change-request' ? target.ref.number : target.ref.number;
      const coords = await this.coords(repositoryId);
      // Retries look for the previous idempotency marker and return that comment instead of posting again.
      const existing = (
        await this.options.client.getAllPages<{ id: number; html_url: string; body: string | null }>(
          `repos/${coords.owner}/${coords.repo}/issues/${number}/comments`,
          { query: { per_page: 100 } },
        )
      ).find((c) => hasIdempotencyMarker(c.body, idempotency.key));
      if (existing) return { nativeId: String(existing.id), url: existing.html_url };
      const res = await this.options.client.post<{ id: number; html_url: string }>(
        `repos/${coords.owner}/${coords.repo}/issues/${number}/comments`,
        { body: { body: withIdempotencyMarker(body.markdown, idempotency.key) } },
      );
      return { nativeId: String(res.data.id), url: res.data.html_url };
    },

    createInlineComment: async (
      ref: ChangeRequestRef,
      anchor: ProviderAnchor,
      body: RichComment,
      _idempotency: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const coords = await this.coords(ref.repositoryId);
      const pull = await this.getPull(coords, ref.number);
      const res = await this.options.client.post<{ id: number; html_url: string }>(
        `repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/comments`,
        {
          body: {
            body: body.markdown,
            commit_id: pull.head.sha,
            path: anchor.path,
            line: anchor.line,
            side: side(anchor.side),
            ...(anchor.startLine !== undefined
              ? { start_line: anchor.startLine, start_side: side(anchor.startSide ?? anchor.side) }
              : {}),
          },
        },
      );
      return { nativeId: String(res.data.id), url: res.data.html_url };
    },

    createReviewBatch: async (
      ref: ChangeRequestRef,
      review: ReviewBatch,
      _idempotency: IdempotencyContext,
    ): Promise<ReviewReceipt> => {
      const coords = await this.coords(ref.repositoryId);
      const eventMap = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' } as const;
      const res = await this.options.client.post<{ id: number; html_url?: string }>(
        `repos/${coords.owner}/${coords.repo}/pulls/${ref.number}/reviews`,
        {
          body: {
            event: eventMap[review.event],
            ...(review.summary ? { body: review.summary.markdown } : {}),
            comments: review.comments.map((c) => ({
              path: c.anchor.path,
              line: c.anchor.line,
              side: side(c.anchor.side),
              body: c.body.markdown,
            })),
          },
        },
      );
      return { nativeId: String(res.data.id), ...(res.data.html_url ? { url: res.data.html_url } : {}) };
    },

    reply: async (
      thread: DiscussionThreadRef,
      body: RichComment,
      _idempotency: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      if (!thread.changeRequest) {
        throw new ProviderError('missing_context', 'reply 需要 thread.changeRequest 上下文');
      }
      const coords = await this.coords(thread.changeRequest.repositoryId);
      const res = await this.options.client.post<{ id: number; html_url: string }>(
        `repos/${coords.owner}/${coords.repo}/pulls/${thread.changeRequest.number}/comments/${thread.nativeId}/replies`,
        { body: { body: body.markdown } },
      );
      return { nativeId: String(res.data.id), threadNativeId: thread.nativeId, url: res.data.html_url };
    },

    editComment: async (comment: CommentRef, body: RichComment): Promise<void> => {
      if (!comment.changeRequest) {
        throw new ProviderError('missing_context', 'editComment 需要 comment.changeRequest 上下文');
      }
      const coords = await this.coords(comment.changeRequest.repositoryId);
      const path =
        comment.scope === 'review'
          ? `repos/${coords.owner}/${coords.repo}/pulls/comments/${comment.nativeId}`
          : `repos/${coords.owner}/${coords.repo}/issues/comments/${comment.nativeId}`;
      await this.options.client.patch(path, { body: { body: body.markdown } });
    },

    // Resolving threads is GraphQL-only.
    resolve: async (thread: DiscussionThreadRef): Promise<void> => {
      const id = await this.reviewThreadNodeId(thread);
      if (!id) return; // thread gone (comment deleted)
      await this.graphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id });
    },
    unresolve: async (thread: DiscussionThreadRef): Promise<void> => {
      const id = await this.reviewThreadNodeId(thread);
      if (!id) return;
      await this.graphql(`mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id });
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
        labels?: ({ name: string } | string)[] | null;
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
      idempotency: IdempotencyContext,
    ): Promise<IssueReceipt> => {
      // Retries look for the previous issue's marker among issues updated in the last 6 hours
      // (first 300); retries happen within minutes.
      const since = new Date(this.now() - 6 * 60 * 60_000).toISOString();
      for (let page = 1; page <= 3; page += 1) {
        const listed = await this.options.client.get<
          { id: number; number: number; html_url: string; body: string | null }[]
        >(`repos/${repo.namespace}/${repo.name}/issues`, {
          query: { state: 'all', since, per_page: 100, page, sort: 'created', direction: 'desc' },
        });
        const hit = listed.data.find((issue) => hasIdempotencyMarker(issue.body, idempotency.key));
        if (hit) {
          return {
            ref: {
              id: uuidv7(this.now()),
              repositoryId: repo.id,
              nativeId: String(hit.id),
              number: hit.number,
            },
            url: hit.html_url,
          };
        }
        if (listed.data.length < 100) break;
      }
      const res = await this.options.client.post<{ id: number; number: number; html_url: string }>(
        `repos/${repo.namespace}/${repo.name}/issues`,
        {
          body: {
            title: input.title,
            body: withIdempotencyMarker(input.body.markdown, idempotency.key),
            ...(input.labels ? { labels: input.labels } : {}),
            ...(input.assignees ? { assignees: input.assignees } : {}),
          },
        },
      );
      return {
        ref: {
          id: uuidv7(this.now()),
          repositoryId: repo.id,
          nativeId: String(res.data.id),
          number: res.data.number,
        },
        url: res.data.html_url,
      };
    },

    comment: async (
      ref: IssueRef,
      body: RichComment,
      _idempotency: IdempotencyContext,
    ): Promise<CommentReceipt> => {
      const coords = await this.coords(ref.repositoryId);
      const res = await this.options.client.post<{ id: number; html_url: string }>(
        `repos/${coords.owner}/${coords.repo}/issues/${ref.number}/comments`,
        { body: { body: body.markdown } },
      );
      return { nativeId: String(res.data.id), url: res.data.html_url };
    },
  };

  checks = {
    createOrUpdate: async (
      repo: RepositoryRef,
      input: CheckInput,
      _idempotency: IdempotencyContext,
    ): Promise<CheckReceipt> => {
      const statusMap = { queued: 'queued', 'in-progress': 'in_progress', completed: 'completed' } as const;
      const conclusionMap = {
        success: 'success',
        failure: 'failure',
        neutral: 'neutral',
        cancelled: 'cancelled',
        'timed-out': 'timed_out',
        'action-required': 'action_required',
      } as const;
      const body = {
        name: input.name,
        head_sha: input.headSha,
        status: statusMap[input.status],
        ...(input.conclusion ? { conclusion: conclusionMap[input.conclusion] } : {}),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: { title: input.title ?? input.name, summary: input.summary ?? '' },
      };
      // GitHub allows duplicate check runs with the same name, so find one by name+headSha and PATCH it;
      // otherwise an in_progress run would stay stuck next to the completed one.
      const existing = await this.options.client.get<{ check_runs: { id: number; name: string }[] }>(
        `repos/${repo.namespace}/${repo.name}/commits/${input.headSha}/check-runs`,
        { query: { check_name: input.name } },
      );
      const hit = existing.data.check_runs.find((c) => c.name === input.name);
      if (hit) {
        const res = await this.options.client.patch<{ id: number; html_url?: string }>(
          `repos/${repo.namespace}/${repo.name}/check-runs/${hit.id}`,
          { body },
        );
        return { nativeId: String(res.data.id), ...(res.data.html_url ? { url: res.data.html_url } : {}) };
      }
      const res = await this.options.client.post<{ id: number; html_url?: string }>(
        `repos/${repo.namespace}/${repo.name}/check-runs`,
        { body },
      );
      return { nativeId: String(res.data.id), ...(res.data.html_url ? { url: res.data.html_url } : {}) };
    },
  };

  // Reactions are idempotent on GitHub: re-posting the same content returns 200.
  reactions = {
    addToChangeRequest: async (ref: ChangeRequestRef, content: ReactionContent): Promise<void> => {
      const coords = await this.coords(ref.repositoryId);
      // A PR is an issue on GitHub, so the issues reactions endpoint applies.
      await this.options.client.post(
        `repos/${coords.owner}/${coords.repo}/issues/${ref.number}/reactions`,
        { body: { content } },
      );
    },
    addToIssue: async (ref: IssueRef, content: ReactionContent): Promise<void> => {
      const coords = await this.coords(ref.repositoryId);
      await this.options.client.post(
        `repos/${coords.owner}/${coords.repo}/issues/${ref.number}/reactions`,
        { body: { content } },
      );
    },
  };

  // Refs carry repositoryId so getJobs/getLogs can resolve owner/repo.
  pipelines = {
    listRuns: async (ref: ChangeRequestRef): Promise<PipelineRun[]> => {
      const coords = await this.coords(ref.repositoryId);
      const pull = await this.getPull(coords, ref.number);
      const res = await this.options.client.get<{
        workflow_runs: { id: number; status: string; head_sha: string; conclusion: string | null }[];
      }>(`repos/${coords.owner}/${coords.repo}/actions/runs`, { query: { head_sha: pull.head.sha } });
      return res.data.workflow_runs.map((r) => ({
        ref: { nativeId: String(r.id), repositoryId: ref.repositoryId },
        status: r.status,
        headSha: r.head_sha,
        ...(r.conclusion !== null ? { conclusion: r.conclusion } : {}),
      }));
    },
    getJobs: async (run: PipelineRunRef): Promise<PipelineJob[]> => {
      const repositoryId = run.repositoryId;
      if (!repositoryId) throw new ProviderError('invalid_request', 'pipelines.getJobs 需 run.ref.repositoryId');
      const coords = await this.coords(repositoryId);
      const res = await this.options.client.get<{
        jobs: { id: number; name: string; status: string; conclusion: string | null }[];
      }>(`repos/${coords.owner}/${coords.repo}/actions/runs/${run.nativeId}/jobs`, { query: { per_page: 100 } });
      return res.data.jobs.map((j) => ({
        ref: { nativeId: String(j.id), repositoryId },
        name: j.name,
        status: j.status,
        ...(j.conclusion !== null ? { conclusion: j.conclusion } : {}),
      }));
    },
    getLogs: async (job: PipelineJobRef): Promise<PipelineLogs> => {
      if (!job.repositoryId) throw new ProviderError('invalid_request', 'pipelines.getLogs 需 job.ref.repositoryId');
      const coords = await this.coords(job.repositoryId);
      // Job logs 302-redirect to a plain-text download; fetch follows it.
      const res = await this.options.client.get<string>(
        `repos/${coords.owner}/${coords.repo}/actions/jobs/${job.nativeId}/logs`,
        { raw: true },
      );
      const text = typeof res.data === 'string' ? res.data : '';
      return { text, truncated: false };
    },
    rerun: async (run: PipelineRunRef): Promise<void> => {
      if (!run.repositoryId) throw new ProviderError('invalid_request', 'pipelines.rerun needs run.repositoryId');
      const coords = await this.coords(run.repositoryId);
      const base = `repos/${coords.owner}/${coords.repo}/actions/runs/${run.nativeId}`;
      const current = await this.options.client.get<{ status: string; conclusion: string | null }>(base);
      // A run still going takes the next review itself (continuation claim); GitHub refuses to re-run it anyway.
      if (current.data.status !== 'completed') return;
      await this.options.client.post(current.data.conclusion === 'failure' ? `${base}/rerun-failed-jobs` : `${base}/rerun`, {});
    },
  };

  branches = {
    get: async (repo: RepositoryRef, name: string): Promise<BranchRef | null> => {
      try {
        const res = await this.options.client.get<{ object: { sha: string } }>(
          `repos/${repo.namespace}/${repo.name}/git/ref/heads/${name}`,
        );
        return { name, sha: res.data.object.sha };
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) return null;
        throw error;
      }
    },
    create: async (repo: RepositoryRef, input: BranchRef): Promise<BranchRef> => {
      await this.options.client.post(`repos/${repo.namespace}/${repo.name}/git/refs`, {
        body: { ref: `refs/heads/${input.name}`, sha: input.sha },
      });
      return input;
    },
    delete: async (repo: RepositoryRef, name: string): Promise<void> => {
      await this.options.client.delete(`repos/${repo.namespace}/${repo.name}/git/refs/heads/${name}`);
    },
  };

  commits = {
    commitChanges: async (
      repo: RepositoryRef,
      input: Parameters<CommitApi['commitChanges']>[1],
    ): Promise<string> => {
      const base = `repos/${repo.namespace}/${repo.name}`;
      const client = this.options.client;
      const parent = await client.get<{ tree: { sha: string } }>(`${base}/git/commits/${input.baseSha}`);
      const tree: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
      for (const change of input.changes) {
        if ('deleted' in change) {
          // A null sha removes the path from the base tree.
          tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const blob = await client.post<{ sha: string }>(`${base}/git/blobs`, {
          body: { content: change.contentBase64, encoding: 'base64' },
        });
        tree.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob.data.sha });
      }
      const created = await client.post<{ sha: string }>(`${base}/git/trees`, {
        body: { base_tree: parent.data.tree.sha, tree },
      });
      const commit = await client.post<{ sha: string }>(`${base}/git/commits`, {
        body: { message: input.message, tree: created.data.sha, parents: [input.baseSha], author: input.author },
      });
      const sha = commit.data.sha;
      try {
        await client.patch(`${base}/git/refs/heads/${input.branch}`, { body: { sha, force: true } });
      } catch (error) {
        // 422 "Reference does not exist": the bot branch is new.
        if (!(error instanceof ProviderError) || (error.status !== 422 && error.status !== 404)) throw error;
        await client.post(`${base}/git/refs`, { body: { ref: `refs/heads/${input.branch}`, sha } });
      }
      return sha;
    },
  };

  webhooks = {
    verify: (raw: RawWebhookDelivery, secret: string): WebhookVerificationResult =>
      verifyGithubWebhook(raw, secret),
    normalize: (raw: RawWebhookDelivery): ProviderWebhookEvent[] => normalizeGithubWebhook(raw),
  };

  capabilities = {
    forChangeRequest: async (_ref: ChangeRequestRef): Promise<ChangeRequestCapabilities> =>
      githubCapabilities(),
  };
}

function mapChangedFile(f: {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}): ChangedFile {
  const statusMap: Record<string, ChangedFile['status']> = {
    added: 'added',
    modified: 'modified',
    removed: 'deleted',
    renamed: 'renamed',
    copied: 'copied',
    changed: 'modified',
  };
  return {
    ...(f.previous_filename ? { oldPath: f.previous_filename } : { oldPath: f.filename }),
    newPath: f.filename,
    status: statusMap[f.status] ?? 'modified',
    additions: f.additions,
    deletions: f.deletions,
  };
}

function mapReviewState(state: string): ReviewRecord['state'] {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
      return 'pending';
    default:
      return 'commented';
  }
}
