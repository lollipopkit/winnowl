<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { api, type FindingDetail } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatRelativeTime } from '$lib/format';
  import { enumLabel, severityLabel } from '$lib/labels';
  import { roleAtLeast, me } from '$lib/me';
  import { notifyInboxChanged } from '$lib/inbox';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import ErrorText from './ErrorText.svelte';
  import X from '@lucide/svelte/icons/x';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import History from '@lucide/svelte/icons/history';
  import CircleMinus from '@lucide/svelte/icons/circle-minus';

  let {
    findingId,
    revisionId,
    onclose,
    onchange,
  }: { findingId: string; revisionId?: string | undefined; onclose: () => void; onchange?: () => void } = $props();

  let detail = $state<FindingDetail | null>(null);
  let error = $state('');
  let dismissing = $state(false);
  let reason = $state('false-positive');
  let proposeRule = $state(true);
  let busy = $state(false);
  let fixRequested = $state(false);

  async function load(): Promise<void> {
    error = '';
    try {
      detail = await api.finding(findingId, revisionId);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void findingId;
    void revisionId;
    detail = null;
    dismissing = false;
    fixRequested = false;
    void load();
  });

  const occ = $derived(detail?.occurrence ?? null);
  const open = $derived(!!occ && !detail?.dismissal && ['inline', 'summary', 'low-evidence', 'unverified-risks'].includes(occ.state) && !['resolved', 'retracted'].includes(detail!.lifecycle));
  const canAct = $derived(roleAtLeast($me?.role, 'member'));
  const highlight = (n: number): boolean => !!occ?.line && (occ.suggestion ? n >= occ.suggestion.startLine && n <= occ.suggestion.endLine : n === occ.line);
  const evidence = $derived((occ?.evidence ?? []).map((e) => (typeof e === 'string' ? e : JSON.stringify(e))));

  async function requestFix(): Promise<void> {
    if (!occ) return;
    busy = true;
    try {
      await api.requestFix(findingId, occ.changeRequestId);
      fixRequested = true;
      notifyInboxChanged();
      toast.success($LL.insp.toastFix());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy = false;
    }
  }

  async function dismiss(): Promise<void> {
    if (!occ) return;
    busy = true;
    try {
      await api.dismissFinding(findingId, { changeRequestId: occ.changeRequestId, reason, proposeRule });
      toast.success(proposeRule ? $LL.insp.toastRuleProposed() : $LL.insp.toastDismissed());
      if (proposeRule) notifyInboxChanged();
      await load();
      onchange?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy = false;
      dismissing = false;
    }
  }

  async function undo(): Promise<void> {
    if (!occ) return;
    busy = true;
    try {
      await api.undismissFinding(findingId, occ.changeRequestId);
      await load();
      onchange?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && !dismissing && onclose()} />

<aside class="insp" aria-label={$LL.insp.title()}>
  <div class="insp-head">
    {#if occ}
      <span class={['insp-sev', `sev-text-${occ.severity}`]}>{severityLabel($LL, occ.severity)}</span>
      <span class="insp-muted">{enumLabel($LL, 'category', detail!.category)}</span>
    {/if}
    <button type="button" class="insp-close" onclick={onclose} aria-label={$LL.insp.close()}><X class="size-4" /></button>
  </div>

  {#if error}
    <ErrorText message={error} />
  {:else if !detail}
    <p class="insp-muted">{$LL.common.loading()}</p>
  {:else}
    <div class="insp-body">
      <p class="insp-claim">{detail.claim}</p>
      {#if occ}
        <div class="insp-tags">
          <span>{enumLabel($LL, 'confirmation', occ.confirmation)}</span>
          <span>{enumLabel($LL, 'relation', occ.changeRelation)}</span>
          <span>{enumLabel($LL, 'placement', occ.state)}</span>
          {#if occ.effort}<span>{enumLabel($LL, 'effort', occ.effort)}</span>{/if}
          {#if occ.blocking}<span class="danger">{$LL.insp.blocking()}</span>{/if}
        </div>

        {#if occ.path}
          <section>
            <h3>{$LL.insp.location()}</h3>
            <code class="insp-loc">{occ.path}{occ.line ? `:${occ.line}` : ''}</code>
            {#if occ.codeContext}
              <pre class="insp-code">{#each occ.codeContext.lines as text, i (i)}<span class={['insp-line', highlight(occ.codeContext.startLine + i) && 'hit']}><span class="insp-ln">{occ.codeContext.startLine + i}</span>{text}
</span>{/each}</pre>
            {/if}
          </section>
        {/if}

        {#if occ.rationale}
          <section>
            <h3>{$LL.insp.why()}</h3>
            <p class="insp-text">{occ.rationale}</p>
          </section>
        {/if}

        <section>
          <h3>{$LL.insp.checks()}</h3>
          <ul class="insp-checks">
            <li><CircleCheck class="size-4 ok" /><span><b>{enumLabel($LL, 'confirmation', occ.confirmation)}</b></span></li>
            {#if occ.refuterUpheld !== null}
              <li>
                {#if occ.refuterUpheld}<ShieldCheck class="size-4 ok" /><span><b>{$LL.insp.refuterFailed()}</b></span>
                {:else}<ShieldAlert class="size-4 warn" /><span><b>{$LL.insp.refuterHeld()}</b></span>{/if}
              </li>
            {/if}
            {#if detail.history.length > 1}
              <li><History class="size-4 warn" /><span><b>{$LL.insp.seenRounds({ n: detail.history.length })}</b></span></li>
            {/if}
            {#if occ.suppressReason}
              <li><CircleMinus class="size-4" /><span><b>{enumLabel($LL, 'suppress', occ.suppressReason)}</b></span></li>
            {/if}
          </ul>
        </section>

        {#if evidence.length}
          <section>
            <h3>{$LL.insp.evidence()}</h3>
            <ul class="insp-evidence">{#each evidence as e, i (i)}<li><code>{e}</code></li>{/each}</ul>
          </section>
        {/if}

        {#if occ.suggestion}
          <section>
            <h3>{$LL.insp.suggestion()}</h3>
            <pre class="insp-code">{#each occ.codeContext?.lines.slice(occ.suggestion.startLine - occ.codeContext.startLine, occ.suggestion.endLine - occ.codeContext.startLine + 1) ?? [] as text, i (i)}<span class="insp-line del">- {text}
</span>{/each}{#each occ.suggestion.replacement.split('\n') as text, i (i)}<span class="insp-line add">+ {text}
</span>{/each}</pre>
          </section>
        {/if}

        {#if canAct}
          <section class="insp-actions">
            {#if detail.dismissal}
              <span class="insp-muted">{$LL.insp.dismissedAs({ reason: enumLabel($LL, 'dismiss', detail.dismissal.reason) })}</span>
              <Button size="sm" variant="outline" disabled={busy} onclick={undo}>{$LL.insp.undo()}</Button>
            {:else if fixRequested}
              <span class="insp-muted">{$LL.insp.fixRequested()}</span>
            {:else if dismissing}
              <div class="insp-dismiss">
                <span class="insp-muted">{$LL.insp.dismissReason()}</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each ['false-positive', 'not-worth-it', 'handled-elsewhere'] as r (r)}
                    <button type="button" class={['insp-chip', reason === r && 'on']} onclick={() => (reason = r)}>{enumLabel($LL, 'dismiss', r)}</button>
                  {/each}
                </div>
                <label class="chk"><Checkbox bind:checked={proposeRule} />{$LL.insp.proposeRule()}</label>
                <div class="flex gap-2">
                  <Button size="sm" disabled={busy} onclick={dismiss}>{$LL.insp.confirmDismiss()}</Button>
                  <Button size="sm" variant="ghost" onclick={() => (dismissing = false)}>{$LL.common.cancel()}</Button>
                </div>
              </div>
            {:else if open}
              <Button size="sm" disabled={busy} onclick={requestFix}>{$LL.insp.requestFix()}</Button>
              <Button size="sm" variant="outline" onclick={() => (dismissing = true)}>{$LL.insp.dismiss()}</Button>
            {/if}
          </section>
        {/if}

        <section>
          <h3>{$LL.insp.history()}</h3>
          <ul class="insp-history">
            {#each detail.history as h (h.revisionId)}
              <li>
                <a href={`/reviews/${h.revisionId}?finding=${detail.id}`}>#{h.changeNumber} · <code>{h.headSha.slice(0, 7)}</code></a>
                <span>{enumLabel($LL, 'placement', h.state)}</span>
                <span class="insp-muted">{formatRelativeTime(h.createdAt, $locale)}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  {/if}
</aside>
