<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type RunnersView } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDateTime, formatEventTime } from '$lib/format';
  import { qs } from '$lib/paging';
  import { me } from '$lib/me';

  import * as Table from '$lib/components/ui/table/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ReviewProgress from '$lib/components/ReviewProgress.svelte';
  import Section from '$lib/components/Section.svelte';
  import ListState from '$lib/components/ListState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';

  const LIMIT = 50;
  const PATH = $page.url.pathname;

  let offset = $state(Number($page.url.searchParams.get('offset') ?? 0) || 0);
  let data = $state<RunnersView | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await api.runners({ limit: LIMIT, offset });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void offset;
    void load();
  });

  function onPage(next: number): void {
    offset = next;
    void goto(`${PATH}${qs({ offset: next || undefined })}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  /** Several heartbeat intervals without a beat means the worker is no longer running. */
  const STALE_MS = 5 * 60_000;
  function isStale(iso: string): boolean {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && Date.now() - t > STALE_MS;
  }
</script>

<PageHeader title={$LL.page.runners()} />

<ReviewProgress />
{#if $me && !$me.isOperator}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{/if}

<div class="stat-row">
  <div class="stat">
    <div class="stat-label">{$LL.runners.queued()}</div>
    <div class="stat-value">{data?.queuedJobs ?? 0}</div>
  </div>
  <div class="stat">
    <div class="stat-label">{$LL.runners.running()}</div>
    <div class="stat-value">{data?.runningJobs ?? 0}</div>
  </div>
</div>

<Section flush>
  <ListState {loading} {error} empty={(data?.total ?? 0) === 0} emptyText={$LL.empty.runnerPools()}>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>{$LL.runners.colWorker()}</Table.Head>
          <Table.Head>{$LL.runners.colPool()}</Table.Head>
          <Table.Head>{$LL.runners.colMode()}</Table.Head>
          <Table.Head>{$LL.runners.colVersion()}</Table.Head>
          <Table.Head>{$LL.runners.colHeartbeat()}</Table.Head>
          <Table.Head class="text-right">{$LL.runners.colLoad()}</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data?.items ?? [] as w (w.id)}
          {@const stale = isStale(w.lastHeartbeatAt)}
          <Table.Row class={stale ? 'opacity-50' : ''}>
            <Table.Cell><code class="text-xs">{w.id.slice(0, 8)}</code></Table.Cell>
            <Table.Cell>{w.pool}</Table.Cell>
            <Table.Cell>{w.mode}</Table.Cell>
            <Table.Cell class="tabular-nums">v{w.version}</Table.Cell>
            <Table.Cell class="text-muted-foreground text-xs" title={formatDateTime(w.lastHeartbeatAt, $locale)}>
              {formatEventTime(w.lastHeartbeatAt, $locale)}
              {#if stale}<span class="ml-1">· {$LL.runners.stale()}</span>{/if}
            </Table.Cell>
            <Table.Cell
              class={[
                'text-right tabular-nums',
                w.runningJobs >= w.maxConcurrency && !stale && 'text-foreground font-medium',
              ]}
            >
              {w.runningJobs}/{w.maxConcurrency}
              <span class="text-muted-foreground">{$LL.runners.jobs()}</span>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {#if data}
      <div class="border-t px-4 py-3">
        <Pagination offset={data.offset} limit={data.limit} total={data.total} onpage={onPage} />
      </div>
    {/if}
  </ListState>
</Section>
