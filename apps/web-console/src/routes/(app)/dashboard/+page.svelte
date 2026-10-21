<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, type DashboardSummary, type InboxItem, type ReviewProgressItem, type SubscriptionView } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatNumber, formatRelativeTime, formatUsd } from '$lib/format';
  import { me, roleAtLeast } from '$lib/me';
  import { severityLabel } from '$lib/labels';
  import { INBOX_ICONS, inboxTitle } from '$lib/inbox-text';
  import { isRunning } from '$lib/review-steps';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import RunningReviewCard from '$lib/components/RunningReviewCard.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import MessageSquareCode from '@lucide/svelte/icons/message-square-code';
  import Send from '@lucide/svelte/icons/send';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleDollarSign from '@lucide/svelte/icons/circle-dollar-sign';

  const POLL_MS = 5_000;

  let summary = $state<DashboardSummary | null>(null);
  let subscription = $state<SubscriptionView | null>(null);
  let pending = $state<InboxItem[]>([]);
  let running = $state<ReviewProgressItem[]>([]);
  let error = $state('');
  let now = $state(Date.now());

  function loadRunning(): void {
    void api
      .reviewProgress()
      .then((r) => (running = r.items.filter(isRunning)))
      .catch(() => undefined);
  }

  $effect(() => {
    api
      .dashboard()
      .then((d) => (summary = d))
      .catch((e: Error) => (error = e.message));
    // Plan and quota are admin-only; members simply don't get the cost tile.
    void api.subscription().then((s) => (subscription = s)).catch(() => undefined);
    void api.inbox('pending').then((r) => (pending = r.items)).catch(() => undefined);
    loadRunning();
    const poll = setInterval(loadRunning, POLL_MS);
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  });

  const name = $derived($me?.displayName ?? $me?.email?.split('@')[0] ?? null);
  const greeting = $derived.by(() => {
    if (!name) return $LL.dashboard.greetPlain();
    const h = new Date(now).getHours();
    if (h < 12) return $LL.dashboard.greetMorning({ name });
    if (h < 18) return $LL.dashboard.greetAfternoon({ name });
    return $LL.dashboard.greetEvening({ name });
  });

  const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
  const fmtPct = (v: number): string => `${formatNumber(v, $locale, { maximumFractionDigits: 1 })}%`;
  const canStop = $derived(roleAtLeast($me?.role, 'member'));

  const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
  const sevClass = (s: string): string => `sev-${SEVERITIES.includes(s) ? s : 'info'}`;
  const openTotal = $derived((summary?.openBySeverity ?? []).reduce((n, s) => n + s.count, 0));
</script>

<PageHeader title={$LL.page.dashboard()} />

{#if error}
  <ErrorText message={error} />
{:else if !summary}
  <Loading />
{:else}
  {@const f = summary.funnel}
  {@const cap = subscription?.plan.monthlyCostCapUsd ?? null}
  <div class="overview">
    <div class="overview-hello">
      <span class="overview-greeting">{greeting}</span>
      <span class="text-muted-foreground">{$LL.dashboard.scope({ repos: summary.activeRepositories })}</span>
    </div>

    <div class="stat-tiles">
      <a class="stat-tile" href="/reviews">
        <span class="stat-tile-label"><MessageSquareCode class="size-4" />{$LL.dashboard.tileReviews()}</span>
        <span class="stat-tile-value">{formatNumber(summary.reviews, $locale)}</span>
        <span class="stat-tile-sub">{$LL.dashboard.tileReviewsSub({ n: running.length })}</span>
      </a>
      <a class="stat-tile" href="/findings">
        <span class="stat-tile-label"><Send class="size-4" />{$LL.dashboard.tilePublished()}</span>
        <span class="stat-tile-value">{formatNumber(f.published, $locale)}</span>
        <span class="stat-tile-sub">{$LL.dashboard.tilePublishedSub({ candidates: f.candidates, rate: fmtPct(pct(f.published, f.candidates)) })}</span>
      </a>
      <div class="stat-tile">
        <span class="stat-tile-label"><CircleCheck class="size-4" />{$LL.dashboard.tileFixed()}</span>
        <span class="stat-tile-value">{formatNumber(f.fixed, $locale)}</span>
        <span class="stat-tile-sub">{$LL.dashboard.tileFixedSub({ rate: fmtPct(pct(f.fixed, f.published)) })}</span>
        <span class="stat-tile-meter"><span style:width={`${pct(f.fixed, f.published)}%`}></span></span>
      </div>
      {#if subscription}
        <a class="stat-tile" href="/usage">
          <span class="stat-tile-label"><CircleDollarSign class="size-4" />{$LL.dashboard.tileCost()}</span>
          <span class="stat-tile-value">{formatUsd(subscription.usage.costUsd, $locale)}</span>
          <span class="stat-tile-sub">
            {cap ? $LL.dashboard.tileCostSub({ cap: formatUsd(cap, $locale), rate: fmtPct(pct(subscription.usage.costUsd, cap)) }) : $LL.dashboard.tileCostUncapped()}
          </span>
          {#if cap}
            <span class={['stat-tile-meter', pct(subscription.usage.costUsd, cap) >= 80 && 'warn']}>
              <span style:width={`${Math.min(100, pct(subscription.usage.costUsd, cap))}%`}></span>
            </span>
          {/if}
        </a>
      {/if}
    </div>

    <div class="overview-cols">
      <div class="overview-main">
        <section class="overview-section">
          <div class="overview-section-head">
            <span class="eyebrow">{$LL.dashboard.needsAction()} · {pending.length}</span>
            <a class="inbox-link" href="/inbox">{$LL.dashboard.openInbox()}</a>
          </div>
          <div class="overview-list">
            {#each pending.slice(0, 3) as it (it.id)}
              {@const Icon = INBOX_ICONS[it.kind]}
              <div class="overview-row">
                <span class="inbox-icon"><Icon class="size-4" /></span>
                <span class="overview-row-text">
                  <span class="overview-row-title">{inboxTitle($LL, it)}</span>
                  <span class="overview-row-sub">{formatRelativeTime(it.createdAt, $locale)}</span>
                </span>
                <Button size="sm" variant="outline" onclick={() => goto('/inbox')}>{$LL.dashboard.handle()}</Button>
              </div>
            {:else}
              <div class="overview-empty">{$LL.dashboard.noPending()}</div>
            {/each}
          </div>
        </section>

        <section class="overview-section">
          <span class="eyebrow">{$LL.dashboard.running()} · {running.length}</span>
          {#each running as r (r.jobId)}
            <RunningReviewCard item={r} {now} {canStop} onchange={loadRunning} />
          {:else}
            <div class="overview-list"><div class="overview-empty">{$LL.dashboard.noRunning()}</div></div>
          {/each}
        </section>
      </div>

      <div class="overview-side">
        <section class="overview-section">
          <span class="eyebrow">{$LL.dashboard.funnel()}</span>
          <div class="overview-card">
            {#each [{ l: $LL.dashboard.fCandidates(), v: f.candidates, c: 'funnel-candidates' }, { l: $LL.dashboard.fVerified(), v: f.verified, c: 'funnel-verified' }, { l: $LL.dashboard.fPublished(), v: f.published, c: 'funnel-published' }, { l: $LL.dashboard.fFixed(), v: f.fixed, c: 'funnel-fixed' }] as row (row.c)}
              <div class="funnel-row">
                <div class="funnel-label"><span>{row.l}</span><b>{formatNumber(row.v, $locale)}</b></div>
                <span class="funnel-track"><span class={row.c} style:width={`${pct(row.v, f.candidates)}%`}></span></span>
              </div>
            {/each}
            {#if f.candidates > f.verified}
              <span class="overview-row-sub">{$LL.dashboard.funnelNote({ n: f.candidates - f.verified })}</span>
            {/if}
          </div>
        </section>

        <section class="overview-section">
          <span class="eyebrow">{$LL.dashboard.openBySeverity()}</span>
          <div class="overview-card">
            {#if openTotal === 0}
              <span class="overview-row-sub">{$LL.dashboard.noOpen()}</span>
            {:else}
              <div class="sev-bar">
                {#each summary.openBySeverity as s (s.severity)}<span class={sevClass(s.severity)} style:flex-grow={s.count}></span>{/each}
              </div>
              <div class="flex flex-wrap gap-1.5">
                {#each summary.openBySeverity as s (s.severity)}
                  <a class="legend-chip" href={`/findings?severity=${s.severity}`}>
                    <span class={['legend-dot', sevClass(s.severity)]}></span>{severityLabel($LL, s.severity)}<b>{s.count}</b>
                  </a>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <section class="overview-section">
          <span class="eyebrow">{$LL.dashboard.recent()}</span>
          <div class="overview-list">
            {#each summary.recentPublished as p (p.findingId)}
              <a class="overview-row" href={`/reviews/${p.revisionId}?finding=${p.findingId}`}>
                <span class={['legend-dot', sevClass(p.severity)]}></span>
                <span class="overview-row-text">
                  <span class="overview-row-title clamp-2">{p.claim}</span>
                  <span class="overview-row-sub">
                    {p.repository.split('/').pop()} #{p.changeNumber}{p.path ? ` · ${p.path}${p.line ? `:${p.line}` : ''}` : ''}
                  </span>
                </span>
              </a>
            {:else}
              <div class="overview-empty">{$LL.dashboard.noRecent()}</div>
            {/each}
          </div>
        </section>
      </div>
    </div>
  </div>
{/if}
