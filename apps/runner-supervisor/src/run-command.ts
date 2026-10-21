import type { ResolvedModelSource } from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import { changeRequestHeadRef, isProviderKind } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig, type CodePlane } from '@reviewbot/review-runtime';
import type { AgentSandbox } from './agent-sandbox.js';
import { commandOutputText } from './agent-sandbox.js';
import type { ConversationReply, ConversationTurnPayload } from './conversation-turn.js';
import { botMessages } from './locale.js';
import { openRepositorySandbox, type StackedFixDeps } from './stacked-fix.js';
import type { JobHandler } from './supervisor.js';

/**
 * run_command job (`run <command>`): runs one shell command in a sandbox on the pull request head and posts the
 * output. The command gate reviews it first, as for the fix agent; the route already checked the commenter.
 */
export interface RunCommandPayload {
  turn: ConversationTurnPayload & { repositoryId: string; changeRequestId: string };
  command: string;
}

export interface RunCommandDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  openRepository: StackedFixDeps['openRepository'];
  validationSandbox?: StackedFixDeps['validationSandbox'];
  /** The command gate's judge. */
  modelSource: () => ResolvedModelSource | null;
  reply: ConversationReply;
}

/** Output posted back; a comment holds 65k characters, and a log tail is what people read. */
const MAX_OUTPUT = 12_000;

export function createRunCommandHandler(deps: RunCommandDeps): JobHandler {
  return async ({ job, db }) => {
    const { turn, command } = job.payload as unknown as RunCommandPayload;
    const cfg = await loadEffectiveConfig(db, turn.tenantId, turn.repositoryId);
    const m = botMessages(cfg.language).conversation;
    const reply = (text: string) => deps.reply(turn, text);
    const judge = deps.modelSource();
    if (!deps.validationSandbox || !judge) return void (await reply(m.runUnavailable()));

    const row = await db
      .selectFrom('change_requests as cr')
      .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
      .select(['cr.number', 'cr.native_id', 'cr.kind', 'repo.installation_id', 'repo.native_id as repo_native_id', 'repo.clone_url'])
      .where('cr.id', '=', turn.changeRequestId)
      .executeTakeFirst();
    const head = await db
      .selectFrom('revisions')
      .select('head_sha')
      .where('change_request_id', '=', turn.changeRequestId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    if (!row || !head) return void (await reply(m.runUnavailable()));

    const provider = await deps.buildProvider(turn.repositoryId);
    const headRef = isProviderKind(provider.kind) ? changeRequestHeadRef(provider.kind, row.number) : undefined;
    let plane: CodePlane | undefined;
    let box: AgentSandbox | undefined;
    try {
      plane = await deps.openRepository(
        { installationId: row.installation_id, nativeId: row.repo_native_id, cloneUrl: row.clone_url },
        { headSha: head.head_sha, ...(headRef ? { headRef } : {}) },
      );
      box = await openRepositorySandbox(deps.validationSandbox, db, plane, cfg, {
        tenantId: turn.tenantId,
        repositoryId: turn.repositoryId,
        jobId: job.id,
        // The judge sees the request, never repository content.
        task: `Run the shell command ${turn.actorLogin} asked for in a comment on pull request #${row.number}, at its head, and report the output: ${command}`,
        judge,
      });
      const outcome = await box.runCommand(command, { purpose: `requested by ${turn.actorLogin} in a pull request comment` });
      await reply(m.runResult({ command, sha: head.head_sha.slice(0, 7), output: commandOutputText(outcome, MAX_OUTPUT) }));
    } finally {
      await box?.close().catch(() => undefined);
      await plane?.dispose().catch(() => undefined);
    }
  };
}
