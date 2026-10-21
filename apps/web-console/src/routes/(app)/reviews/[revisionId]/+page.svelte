<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type ReviewDetail, type ReviewFinding } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatNumber, formatRelativeTime, formatUsd } from '$lib/format';
  import { enumLabel, severityLabel } from '$lib/labels';
  import { reviewSteps, stepCount, stepsUsable } from '$lib/review-steps';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import FindingInspector from '$lib/components/FindingInspector.svelte';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import { Button } from '$lib/components/ui/button/index.js';
  import ExternalLink from '@lucide/svelte/icons/external-link';

  const revisionId = $derived($page.params.revisionId!);
  const selected = $derived($page.url.searchParams.get('finding'));

  let detail = $state<ReviewDetail | null>(null);
  let error = $state('');
  let showSuppressed = $state(false);

  async function load(): Promise<void> {
    try {
      detail = await api.review(revisionId);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void revisionId;
    void load();
    const poll = setInterval(() => {
      if (detail?.run.state === 'running') void load();
    }, 5_000);
    return () => clearInterval(poll);
  });

  function select(id: string | null): void {
    const url = new URL($page.url);
    if (id && id !== selected) url.searchParams.set('finding', id);
    else url.searchParams.delete('finding');
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  const steps = $derived(reviewSteps($LL));
  const usd = (n: number | null): string => (n === null ? '—' : formatUsd(n, $locale));
  const prUrl = $derived(detail?.publications.find((p) => p.providerUrl)?.providerUrl ?? null);
  const inline = $derived(detail?.findings.filter((f) => f.state === 'inline').length ?? 0);
  const summary = $derived(detail?.findings.filter((f) => f.state === 'summary').length ?? 0);
  const lifecycleClass = (f: ReviewFinding): string => (f.lifecycle === 'resolved' ? 'text-primary' : f.lifecycle === 'dismissed' ? 'text-muted-foreground' : '');
</script>

<PageHeader
  title={detail ? (detail.run.title ?? `${detail.run.repository.split('/').pop()} #${detail.run.changeNumber}`) : $LL.nav.reviews()}
  parent={{ label: $LL.nav.reviews(), href: '/reviews' }}
>
  {#snippet actions()}
    {#if prUrl}
      <Button variant="outline" size="sm" href={prUrl} target="_blank" rel="noreferrer"><ExternalLink />{$LL.rv.openPr()}</Button>
    {/if}
  {/snippet}
</PageHeader>

{#if error}
  <ErrorText message={error} />
{:else if !detail}
  <Loading />
{:else}
  {@const run = detail.run}
  <div class={['with-insp', selected && 'open']}>
    <div class="review-detail">
      <div class="review-meta">
        <span>{run.repository}</span>
        {#if run.sourceBranch}<span>{run.sourceBranch} → {run.targetBranch}</span>{/if}
        <code>{run.headSha.slice(0, 7)}</code>
        <span>{formatRelativeTime(run.createdAt, $locale)}</span>
      </div>

      <div class="metrics">
        {#if run.candidates !== null}
          {#if detail.areas}
            <div class="metric"><span>{$LL.rv.mAreas()}</span><b>{detail.areas.complete} / {detail.areas.total}</b><small>{$LL.rv.mAreasSub()}</small></div>
          {/if}
          <div class="metric"><span>{$LL.rv.mCandidates()}</span><b>{formatNumber(run.candidates, $locale)}</b><small>{$LL.rv.mCandidatesSub()}</small></div>
          <div class="metric"><span>{$LL.rv.mVerified()}</span><b>{formatNumber(run.verified, $locale)}</b><small>{$LL.rv.mVerifiedSub()}</small></div>
          <div class="metric"><span>{$LL.rv.mPublished()}</span><b class="text-primary">{formatNumber(run.published, $locale)}</b><small>{$LL.rv.mPublishedSub({ inline, summary })}</small></div>
        {:else}
          <div class="metric"><span>{$LL.rv.colState()}</span><b>{enumLabel($LL, 'reviewState', run.state)}</b></div>
        {/if}
        <div class="metric">
          <span>{$LL.rv.colGate()}</span>
          {#if run.gate}
            <b class={run.gate === 'block' ? 'text-destructive' : 'text-primary'}>{enumLabel($LL, 'gate', run.gate)}</b>
            <small>{run.gate === 'block' ? $LL.rv.mGateBlock({ n: run.blockingCount ?? 0 }) : $LL.rv.mGatePass()}</small>
          {:else}
            <b>—</b><small>{$LL.rv.mGateOff()}</small>
          {/if}
        </div>
        <div class="metric"><span>{$LL.rv.colCost()}</span><b>{usd(run.costUsd)}</b><small>{$LL.rv.mCostSub()}</small></div>
      </div>

      {#if run.state === 'running' && run.progress && stepsUsable(run.progress, steps.length)}
        {@const at = run.progress.stepIndex!}
        <div class="run-card">
          <div class="run-steps">
            {#each steps as label, i (i)}
              <div class={['run-step', i < at && 'done', i === at && 'now']}><span class="run-bar"></span><span>{label}</span></div>
            {/each}
          </div>
          {#if stepCount($LL, run.progress)}<span class="run-sub">{stepCount($LL, run.progress)}</span>{/if}
        </div>
      {/if}

      <section class="overview-section">
        <span class="eyebrow">{$LL.rv.sPublished()} · {detail.findings.length}</span>
        <div class="overview-list">
          {#each detail.findings as f (f.findingId)}
            <button type="button" class={['finding-row', selected === f.findingId && 'on']} onclick={() => select(f.findingId)}>
              <span class={['finding-sev', `sev-text-${f.severity}`]}>{severityLabel($LL, f.severity)}</span>
              <span class="finding-text">
                <span class="finding-claim">{f.claim}</span>
                <span class="overview-row-sub">
                  {f.path ? `${f.path}${f.line ? `:${f.line}` : ''} · ` : ''}{enumLabel($LL, 'category', f.category)} · {enumLabel($LL, 'placement', f.state)}
                </span>
              </span>
              <span class={['finding-life', lifecycleClass(f)]}>{enumLabel($LL, 'lifecycle', f.lifecycle)}</span>
            </button>
          {:else}
            <div class="overview-empty">{$LL.rv.noFindings()}</div>
          {/each}
        </div>
      </section>

      {#if detail.risks.length}
        <section class="overview-section">
          <span class="eyebrow">{$LL.rv.sRisks()} · {detail.risks.length}</span>
          <div class="overview-list">
            {#each detail.risks as f (f.findingId)}
              <button type="button" class={['finding-row', selected === f.findingId && 'on']} onclick={() => select(f.findingId)}>
                <span class={['finding-sev', `sev-text-${f.severity}`]}>{severityLabel($LL, f.severity)}</span>
                <span class="finding-text"><span class="finding-claim">{f.claim}</span></span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if detail.suppressed.length || detail.refutedCount}
        <section class="overview-section">
          <button type="button" class="section-toggle" onclick={() => (showSuppressed = !showSuppressed)}>
            <span class="eyebrow">{$LL.rv.sSuppressed()} · {detail.suppressed.length + detail.refutedCount}</span>
            {#if showSuppressed}<ChevronUp class="size-4" />{:else}<ChevronDown class="size-4" />{/if}
          </button>
          {#if showSuppressed}
            <div class="overview-list">
              {#each detail.suppressed as s (s.findingId)}
                <div class="suppressed-row">
                  <span class="text-muted-foreground flex-1">{s.claim}</span>
                  <span class="suppressed-reason">{s.reason ? enumLabel($LL, 'suppress', s.reason) : '—'}</span>
                </div>
              {/each}
              {#if detail.refutedCount}
                <div class="overview-empty">{$LL.rv.refutedNote({ n: detail.refutedCount })}</div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      {#if detail.publications.length}
        <section class="overview-section">
          <span class="eyebrow">{$LL.rv.sPosted()}</span>
          <div class="flex flex-wrap gap-2">
            {#if detail.publications.some((p) => p.kind === 'review')}<span class="posted-chip">{$LL.rv.postedSummary()}</span>{/if}
            {#if inline}<span class="posted-chip">{$LL.rv.postedInline({ n: inline })}</span>{/if}
            {#if run.gate}<span class={['posted-chip', run.gate === 'block' && 'danger']}>{$LL.rv.postedCheck({ state: enumLabel($LL, 'gate', run.gate) })}</span>{/if}
          </div>
        </section>
      {/if}
    </div>

    {#if selected}
      <FindingInspector findingId={selected} {revisionId} onclose={() => select(null)} onchange={load} />
    {/if}
  </div>
{/if}
