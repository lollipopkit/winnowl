<script lang="ts">
  import { api, type Installation } from '$lib/api';
  import { nextSort, type Paged, type SortDir } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDateTime } from '$lib/format';
  import Badge from '$lib/components/Badge.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import ListState from '$lib/components/ListState.svelte';
  import SelectField from '$lib/components/SelectField.svelte';
  import Section from '$lib/components/Section.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  const LIMIT = 20;
  const STATUSES = ['active', 'suspended', 'removed'];

  let q = $state({ offset: 0, sort: 'createdAt', dir: 'desc' as SortDir, status: '', q: '' });
  let search = $state('');
  let result = $state<Paged<Installation> | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const args = { limit: LIMIT, offset: q.offset, sort: q.sort, dir: q.dir, status: q.status || undefined, q: q.q || undefined };
    api
      .installations(args)
      .then((r) => ((result = r), (error = null)))
      .catch((e: Error) => (error = e.message));
  });

  let timer: ReturnType<typeof setTimeout>;
  function onSearch(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q.q = search.trim();
      q.offset = 0;
    }, 300);
  }
  function sortBy(field: string): void {
    const s = nextSort({ sort: q.sort, dir: q.dir }, field);
    q.sort = s.sort;
    q.dir = s.dir;
    q.offset = 0;
  }

  const columns = $derived<Column[]>([
    { key: 'account', label: $LL.col.account(), sortable: true },
    { key: 'status', label: $LL.col.status(), sortable: true },
    { key: 'createdAt', label: $LL.col.created(), sortable: true, align: 'end' },
  ]);
</script>

<Section title={$LL.page.installations()} flush>
  <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
    <Input class="grow" placeholder={$LL.list.searchAccount()} bind:value={search} oninput={onSearch} />
    <SelectField
      options={[{ value: '', label: `${$LL.list.all()} · ${$LL.col.status()}` }, ...STATUSES.map((s) => ({ value: s, label: s }))]}
      bind:value={q.status}
      onchange={() => (q.offset = 0)}
    />
  </div>
  <ListState {error} loading={!result} empty={result?.total === 0} skeletonColumns={columns.length}>
    {#if result}
      <DataTable {columns} items={result.items} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} onSort={sortBy}>
        {#snippet row(r)}
          <Table.Cell>{r.accountLogin ?? '—'}</Table.Cell>
          <Table.Cell><Badge value={r.status} /></Table.Cell>
          <Table.Cell class="text-muted-foreground text-right">{formatDateTime(r.createdAt, $locale)}</Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </ListState>
  {#if result && result.total > LIMIT}
    <div class="border-t px-4 py-3"><Pagination offset={result.offset} limit={result.limit} total={result.total} onpage={(o) => (q.offset = o)} /></div>
  {/if}
</Section>
