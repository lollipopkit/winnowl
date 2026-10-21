<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type Repository } from '$lib/api';
  import { qs, nextSort, type Paged, type SortDir } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatRelativeTime } from '$lib/format';
  import Pagination from '$lib/components/Pagination.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import ListState from '$lib/components/ListState.svelte';

  import * as Table from '$lib/components/ui/table/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { repoTabs } from '$lib/tabs';
  import Section from '$lib/components/Section.svelte';
  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;

  let q = $state({
    offset: Number(sp.get('offset') ?? 0) || 0,
    sort: sp.get('sort') ?? 'namespace',
    dir: (sp.get('dir') as SortDir) ?? 'asc',
    q: sp.get('q') ?? '',
  });
  let search = $state(sp.get('q') ?? '');
  let result = $state<Paged<Repository> | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      result = await api.repositories({ limit: LIMIT, offset: q.offset, sort: q.sort, dir: q.dir, q: q.q || undefined });
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function pushUrl() {
    const query = qs({ offset: q.offset || undefined, sort: q.sort !== 'namespace' ? q.sort : undefined, dir: q.dir !== 'asc' ? q.dir : undefined, q: q.q || undefined });
    void goto(`${PATH}${query}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  $effect(() => {
    void [q.offset, q.sort, q.dir, q.q];
    void load();
  });

  let timer: ReturnType<typeof setTimeout>;
  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q.q = search.trim();
      q.offset = 0;
      pushUrl();
    }, 300);
  }
  function sortBy(field: string) {
    const s = nextSort({ sort: q.sort, dir: q.dir }, field);
    q.sort = s.sort;
    q.dir = s.dir;
    q.offset = 0;
    pushUrl();
  }
  function onPage(offset: number) {
    q.offset = offset;
    pushUrl();
  }

  const columns = $derived<Column[]>([
    { key: 'namespace', label: $LL.col.name(), sortable: true },
    { key: 'source', label: $LL.config.colSource() },
    { key: 'preset', label: $LL.config.colPreset() },
    { key: 'gate', label: $LL.config.colGate() },
    { key: 'reviews', label: $LL.config.colReviews(), align: 'end' },
    { key: 'last', label: $LL.config.colLast(), align: 'end' },
  ]);
  const presetLabel = (p: string): string =>
    p === 'conservative' ? $LL.config.pConservative() : p === 'thorough' ? $LL.config.pThorough() : $LL.config.pBalanced();
</script>

<PageHeader tabs={repoTabs($LL)} />

<Section flush>
  <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
    <Input class="grow" placeholder={$LL.list.searchRepo()} bind:value={search} oninput={onSearch} />
  </div>

  <ListState {error} loading={!result} empty={result?.total === 0} skeletonColumns={columns.length}>
    {#if result}
      <DataTable {columns} items={result.items} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} onSort={sortBy} onRowClick={(r) => goto(`/repositories/${r.id}/config`)}>
        {#snippet row(r)}
          <Table.Cell class="cell-name">
            <span class="cell-strong">{r.namespace}/{r.name}</span>
            <span class="cell-sub">{r.forge}</span>
          </Table.Cell>
          <Table.Cell class={r.configSource === 'repo-file' ? 'font-mono text-xs' : 'text-muted-foreground'}>
            {r.configSource === 'repo-file' ? $LL.config.sourceYaml() : $LL.config.sourcePanel()}
          </Table.Cell>
          <Table.Cell>{presetLabel(r.profile)}</Table.Cell>
          <Table.Cell class={r.mergeGate ? 'text-destructive' : 'text-muted-foreground'}>{r.mergeGate ? $LL.config.gateBlock() : $LL.config.gateComment()}</Table.Cell>
          <Table.Cell class="text-right tabular-nums">{$LL.config.reviewsN({ n: r.reviews30d })}</Table.Cell>
          <Table.Cell class="text-muted-foreground text-right">{r.lastReviewAt ? formatRelativeTime(r.lastReviewAt, $locale) : '—'}</Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </ListState>
  {#if result}
    <div class="border-t px-4 py-3"><Pagination offset={result.offset} limit={result.limit} total={result.total} onpage={onPage} /></div>
  {/if}
</Section>

