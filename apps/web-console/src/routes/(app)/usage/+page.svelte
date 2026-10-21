<script lang="ts">
  import type { Component } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { api, type ByokMeta, type PlanModelsView, type SubscriptionView, type UsageSummary } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDate, formatNumber, formatUsd } from '$lib/format';
  import { me, roleAtLeast } from '$lib/me';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ByokCard from '$lib/components/ByokCard.svelte';
  import PluginSettings from '$lib/components/PluginSettings.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
  import CircleDollarSign from '@lucide/svelte/icons/circle-dollar-sign';
  import MessageSquareCode from '@lucide/svelte/icons/message-square-code';
  import Coins from '@lucide/svelte/icons/coins';

  let sub = $state<SubscriptionView | null>(null);
  let error = $state('');
  let usage = $state<UsageSummary | null>(null);
  let models = $state<PlanModelsView | null>(null);
  let orgByok = $state<ByokMeta | null>(null);
  let savingOverage = $state(false);

  const isAdmin = $derived(roleAtLeast($me?.role, 'admin'));
  const isOwner = $derived(roleAtLeast($me?.role, 'owner'));

  api
    .subscription()
    .then((s) => (sub = s))
    .catch((e: Error) => (error = e.message));
  api.subscriptionModels().then((m) => (models = m)).catch(() => undefined);
  $effect(() => {
    if (!isAdmin) return;
    void api.usage().then((u) => (usage = u)).catch(() => undefined);
    // An org-level BYOK overrides the platform model.
    void api.byok().then((v) => (orgByok = v.byok)).catch(() => undefined);
  });

  const effectiveModel = $derived(models?.allowed.find((m) => m.id === models?.effectiveId));
  const usd = (n: number): string => formatUsd(n, $locale);
  const int = (n: number): string => formatNumber(n, $locale);
  const pct = (used: number, cap: number | null): number => (cap ? Math.min(100, (used / cap) * 100) : 0);

  /** Linear month-end estimate from spend so far. */
  const projected = $derived.by(() => {
    if (!sub) return null;
    const start = Date.parse(sub.periodStart);
    const end = Date.parse(sub.periodEnd);
    const elapsed = Math.max(Date.now() - start, 86_400_000);
    return Math.round(((sub.usage.costUsd / elapsed) * (end - start)) * 100) / 100;
  });
  /** Period bounds are UTC midnights; show them as calendar days, the end inclusive. */
  const utcDay = (iso: string, offsetDays = 0): Date => {
    const d = new Date(Date.parse(iso) + offsetDays * 86_400_000);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };

  const tierLabel = (t: string): string =>
    t === 'quality' ? $LL.billing.tierQuality() : t === 'cheap' ? $LL.billing.tierCheap() : $LL.billing.tierBalanced();

  async function setOverage(action: string): Promise<void> {
    if (!sub || action === sub.overageAction) return;
    savingOverage = true;
    try {
      await api.setOveragePolicy(action);
      sub = { ...sub, overageAction: action };
      toast.success($LL.common.saved());
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      savingOverage = false;
    }
  }

  const repoColumns = $derived<Column[]>([
    { key: 'repository', label: $LL.billing.colRepo() },
    { key: 'reviews', label: $LL.billing.colReviews(), align: 'end' },
    { key: 'tokens', label: $LL.billing.colTokens(), align: 'end' },
    { key: 'cost', label: $LL.billing.colCost(), align: 'end' },
    { key: 'avg', label: $LL.billing.colAvg(), align: 'end' },
  ]);
</script>

{#snippet tile(Icon: Component, label: string, value: string, cap: number | null, used: number, capText: string, extra = '')}
  <div class="stat-tile">
    <span class="stat-tile-label"><Icon class="size-4" />{label}</span>
    <span class="stat-tile-value">{value}</span>
    <span class="stat-tile-sub">{cap === null ? $LL.billing.uncapped() : [$LL.billing.capOf({ cap: capText }), extra].filter(Boolean).join(' · ')}</span>
    {#if cap !== null}
      <span class={['stat-tile-meter', pct(used, cap) >= 80 && 'warn']}><span style:width={`${pct(used, cap)}%`}></span></span>
    {/if}
  </div>
{/snippet}

<PageHeader title={$LL.nav.usage()} />

{#if error}
  <ErrorText message={error} />
{:else if !sub}
  <Loading />
{:else}
  <div class="billing">
    <p class="text-muted-foreground m-0">
      {$LL.billing.intro({ start: formatDate(utcDay(sub.periodStart), $locale), end: formatDate(utcDay(sub.periodEnd, -1), $locale) })}
    </p>

    <div class="billing-plan">
      <span class="billing-plan-name">{sub.plan.name}</span>
      <span class="text-muted-foreground">{$LL.billing.planDesc({ tier: tierLabel(sub.plan.modelTier), n: sub.plan.maxConcurrency })}</span>
    </div>

    <div class="stat-tiles">
      {@render tile(
        CircleDollarSign,
        $LL.billing.tileCost(),
        usd(sub.usage.costUsd),
        sub.plan.monthlyCostCapUsd,
        sub.usage.costUsd,
        usd(sub.plan.monthlyCostCapUsd ?? 0),
        projected !== null ? $LL.billing.projected({ amount: usd(projected) }) : '',
      )}
      {@render tile(MessageSquareCode, $LL.billing.tileReviews(), int(sub.usage.reviews), sub.plan.monthlyReviewQuota, sub.usage.reviews, int(sub.plan.monthlyReviewQuota ?? 0))}
      {@render tile(Coins, $LL.billing.tileTokens(), int(sub.usage.tokens), sub.plan.monthlyTokenQuota, sub.usage.tokens, int(sub.plan.monthlyTokenQuota ?? 0))}
    </div>
    {#if !sub.withinQuota}<div class="settings-notice text-destructive">{$LL.quota.exhausted()}</div>{/if}

    <section class="settings-group">
      <h2>{$LL.billing.overTitle()}</h2>
      <div class="setting-row">
        <div class="setting-label">
          <span>{$LL.billing.overRow()}</span>
          <small>{sub.overageAction === 'degrade' ? $LL.billing.hintDegrade() : $LL.billing.hintReject()}</small>
        </div>
        <div class="setting-control">
          <ToggleGroup.Root
            type="single"
            variant="outline"
            size="sm"
            value={sub.overageAction}
            disabled={!isOwner || savingOverage}
            onValueChange={(v) => v && setOverage(v)}
          >
            <ToggleGroup.Item class="seg-item" value="degrade">{$LL.billing.overDegrade()}</ToggleGroup.Item>
            <ToggleGroup.Item class="seg-item" value="reject">{$LL.billing.overReject()}</ToggleGroup.Item>
          </ToggleGroup.Root>
        </div>
      </div>
      {#if !isOwner}<small class="text-muted-foreground">{$LL.billing.ownerOnly()}</small>{/if}
      {#if orgByok || effectiveModel}
        <div class="setting-row">
          <div class="setting-label"><span>{$LL.quota.model()}</span></div>
          <div class="setting-control">
            {#if orgByok}
              <span class="font-medium">{orgByok.provider}/{orgByok.model}</span><Badge value="BYOK" tone="accent" />
            {:else if effectiveModel}
              <span class="font-medium">{effectiveModel.provider}/{effectiveModel.modelId}</span>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  </div>

  <ByokCard canManage={isAdmin} />
  <PluginSettings />

  {#if isAdmin && usage}
    <Section title={$LL.billing.byRepo()} flush>
      {#if usage.byRepository.length === 0}
        <div class="px-5"><EmptyState title={$LL.empty.usage()} compact /></div>
      {:else}
        <DataTable columns={repoColumns} items={usage.byRepository} rowKey={(r) => r.repository}>
          {#snippet row(r)}
            <Table.Cell class="font-medium">{r.repository}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{int(r.reviews)}</Table.Cell>
            <Table.Cell class="text-muted-foreground text-right tabular-nums">{int(r.totalTokens)}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{usd(r.costUsd)}</Table.Cell>
            <Table.Cell class="text-muted-foreground text-right tabular-nums">{usd(r.reviews ? r.costUsd / r.reviews : 0)}</Table.Cell>
          {/snippet}
        </DataTable>
      {/if}
    </Section>
  {/if}
{/if}
