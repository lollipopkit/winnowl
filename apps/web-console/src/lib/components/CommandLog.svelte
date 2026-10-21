<script lang="ts">
  /** Commands an agent asked to run in its sandbox for one plan, with the command gate's decision. Loaded on demand. */
  import { api, type AgentCommandRow } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatEventTime } from '$lib/format';
  import Badge from './Badge.svelte';
  import ErrorText from './ErrorText.svelte';
  import { Button } from '$lib/components/ui/button/index.js';

  let { planId }: { planId: string } = $props();
  let open = $state(false);
  let rows = $state<AgentCommandRow[] | null>(null);
  let error = $state('');

  async function toggle(): Promise<void> {
    open = !open;
    if (!open || rows) return;
    try {
      rows = (await api.actionPlanCommands(planId)).commands;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const outcome = (r: AgentCommandRow): string => {
    if (r.verdict === 'deny') return '';
    if (r.timedOut) return $LL.conversations.cmdTimedOut();
    if (r.oomKilled) return $LL.conversations.cmdOom();
    if (r.exitCode === undefined) return '';
    return $LL.conversations.cmdExit({ code: r.exitCode, seconds: Math.round((r.durationMs ?? 0) / 1000) });
  };
</script>

<div class="mt-2">
  <Button variant="ghost" size="sm" onclick={toggle}>{open ? $LL.conversations.cmdHide() : $LL.conversations.cmdShow()}</Button>
  {#if open}
    {#if error}<ErrorText message={error} />{/if}
    {#if rows && rows.length === 0}
      <p class="text-muted-foreground mt-2 mb-0 text-xs">{$LL.conversations.cmdNone()}</p>
    {:else if rows}
      <ul class="command-log">
        {#each rows as r (r.id)}
          <li>
            <div class="flex flex-wrap items-center gap-2">
              <Badge value={r.verdict === 'allow' ? $LL.conversations.cmdAllowed() : $LL.conversations.cmdDenied()} tone={r.verdict === 'allow' ? 'ok' : 'danger'} />
              <span class="text-muted-foreground text-xs">{r.decidedBy === 'judge' ? $LL.conversations.cmdByJudge() : $LL.conversations.cmdByRule({ rule: r.rule })}</span>
              <span class="text-muted-foreground text-xs">{outcome(r)}</span>
              <span class="text-muted-foreground ml-auto text-xs" title={r.createdAt}>{formatEventTime(r.createdAt, $locale)}</span>
            </div>
            <code class="command-log-cmd">{r.command}</code>
            {#if r.purpose}<p class="text-muted-foreground m-0 text-xs">{r.purpose}</p>{/if}
            {#if r.verdict === 'deny' || r.decidedBy === 'judge'}<p class="m-0 text-xs">{r.reason}</p>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
