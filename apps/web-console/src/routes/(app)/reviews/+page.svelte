<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type Repository, type ReviewRun } from '$lib/api';
  import { qs, nextSort, type Paged, type SortDir } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatRelativeTime, formatUsd } from '$lib/format';
  import { enumLabel, severityLabel } from '$lib/labels';
  import { reviewSteps, stepCount, stepsUsable } from '$lib/review-steps';
  import Pagination from '$lib/components/Pagination.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import ListState from '$lib/components/ListState.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';

  const LIMIT = 50;
  const POLL_MS = 5_000;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;

  let q = $state({
    offset: Number(sp.get('offset') ?? 0) || 0,
    sort: sp.get('sort') ?? 'createdAt',
    dir: (sp.get('dir') as SortDir) ?? 'desc',
    status: sp.get('status') ?? '',
    repositoryId: sp.get('repositoryId') ?? '',
  });

  let result = $state<Paged<ReviewRun> | null>(null);
  let error = $state<string | null>(null);
  let repos = $state<Repository[]>([]);

  api
    .repositories({ limit: 200, sort: 'namespace', dir: 'asc' })
    .then((r) => (repos = r.items))
    .catch(() => (repos = []));

  async function load(): Promise<void> {
    try {
      result = await api.reviews({
        limit: LIMIT,
        offset: q.offset,
        sort: q.sort,
        dir: q.dir,
        status: q.status || undefined,
        repositoryId: q.repositoryId || undefined,
      });
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function pushUrl(): void {
    const query = qs({
      offset: q.offset || undefined,
      sort: q.sort !== 'createdAt' ? q.sort : undefined,
      dir: q.dir !== 'desc' ? q.dir : undefined,
      status: q.status || undefined,
      repositoryId: q.repositoryId || undefined,
    });
    void goto(`${PATH}${query}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  $effect(() => {
    void [q.offset, q.sort, q.dir, q.status, q.repositoryId];
    void load();
    // Running rows advance their step; refresh while any is in flight.
    const poll = setInterval(() => {
      if (result?.items.some((r) => r.state === 'running')) void load();
    }, POLL_MS);
    return () => clearInterval(poll);
  });

  function sortBy(field: string): void {
    const s = nextSort({ sort: q.sort, dir: q.dir }, field);
    q.sort = s.sort;
    q.dir = s.dir;
    q.offset = 0;
    pushUrl();
  }
  function onFilter(): void {
    q.offset = 0;
    pushUrl();
  }

  const steps = $derived(reviewSteps($LL));
  function stateText(r: ReviewRun): string {
    if (r.state === 'running' && r.progress && stepsUsable(r.progress, steps.length)) {
      return [steps[r.progress.stepIndex!], stepCount($LL, r.progress)].filter(Boolean).join(' · ');
    }
    return enumLabel($LL, 'reviewState', r.state);
  }

  const columns = $derived<Column[]>([
    { key: 'change', label: $LL.rv.colChange(), sortable: true },
    { key: 'state', label: $LL.rv.colState() },
    { key: 'published', label: $LL.rv.colPublished(), align: 'end' },
    { key: 'top', label: $LL.rv.colTop() },
    { key: 'gate', label: $LL.rv.colGate() },
    { key: 'cost', label: $LL.rv.colCost(), align: 'end' },
    { key: 'createdAt', label: $LL.rv.colTime(), sortable: true, align: 'end' },
  ]);
</script>

<PageHeader title={$LL.nav.reviews()}>
  {#snippet actions()}
    <SelectField
      options={[{ value: '', label: String($LL.list.allRepositories()) }, ...repos.map((r) => ({ value: r.id, label: `${r.namespace}/${r.name}` }))]}
      bind:value={q.repositoryId}
      onchange={onFilter}
    />
    <Tabs.Root value={q.status || 'all'} onValueChange={(v) => ((q.status = v === 'all' ? '' : v), onFilter())}>
      <Tabs.List>
        <Tabs.Trigger value="all">{$LL.rv.filterAll()}</Tabs.Trigger>
        <Tabs.Trigger value="running">{$LL.rv.filterRunning()}</Tabs.Trigger>
        <Tabs.Trigger value="blocked">{$LL.rv.filterBlocked()}</Tabs.Trigger>
        <Tabs.Trigger value="failed">{$LL.rv.filterFailed()}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/snippet}
</PageHeader>

<Section flush>
  <ListState {error} loading={!result} empty={result?.total === 0} skeletonColumns={columns.length}>
    {#if result}
      <DataTable
        {columns}
        items={result.items}
        rowKey={(r) => r.revisionId}
        sort={q.sort}
        dir={q.dir}
        onSort={sortBy}
        onRowClick={(r) => goto(`/reviews/${r.revisionId}`)}
      >
        {#snippet row(r)}
          <Table.Cell class="cell-name">
            <span class="cell-strong">{r.title ?? `#${r.changeNumber}`}</span>
            <span class="cell-sub">{r.repository.split('/').pop()} #{r.changeNumber}</span>
          </Table.Cell>
          <Table.Cell>
            <span class={['state-dot', `state-${r.state}`]}></span>{stateText(r)}
          </Table.Cell>
          <Table.Cell class="text-right tabular-nums">{r.candidates !== null ? `${r.published} / ${r.candidates}` : '—'}</Table.Cell>
          <Table.Cell>
            {#if r.topSeverity}<span class={`sev-text-${r.topSeverity}`}>{severityLabel($LL, r.topSeverity)}</span>{:else}—{/if}
          </Table.Cell>
          <Table.Cell>
            {#if r.gate}<span class={r.gate === 'block' ? 'text-destructive' : 'text-primary'}>{enumLabel($LL, 'gate', r.gate)}</span>{:else}—{/if}
          </Table.Cell>
          <Table.Cell class="text-muted-foreground text-right tabular-nums">{r.costUsd !== null ? formatUsd(r.costUsd, $locale) : '—'}</Table.Cell>
          <Table.Cell class="text-muted-foreground text-right">{formatRelativeTime(r.createdAt, $locale)}</Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </ListState>
  {#if result}
    <div class="border-t px-4 py-3">
      <Pagination offset={result.offset} limit={result.limit} total={result.total} onpage={(o) => ((q.offset = o), pushUrl())} />
    </div>
  {/if}
</Section>
