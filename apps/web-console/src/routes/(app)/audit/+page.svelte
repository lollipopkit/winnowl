<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type AuditEntry } from '$lib/api';
  import SelectField from '$lib/components/SelectField.svelte';
  import { qs, nextSort, type Paged, type SortDir } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDateTime } from '$lib/format';
  import { enumLabel } from '$lib/labels';
  import Pagination from '$lib/components/Pagination.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import ListState from '$lib/components/ListState.svelte';

  import * as Table from '$lib/components/ui/table/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;

  let q = $state({
    offset: Number(sp.get('offset') ?? 0) || 0,
    sort: sp.get('sort') ?? 'createdAt',
    dir: (sp.get('dir') as SortDir) ?? 'desc',
    q: sp.get('q') ?? '',
    actor: sp.get('actor') ?? '',
    action: sp.get('action') ?? '',
  });
  let facets = $state<{ actions: string[]; actors: { id: string; label: string | null }[] }>({ actions: [], actors: [] });
  api
    .auditFacets()
    .then((f) => (facets = f))
    .catch(() => undefined);
  let search = $state(sp.get('q') ?? '');
  let result = $state<Paged<AuditEntry> | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      result = await api.audit({
        limit: LIMIT,
        offset: q.offset,
        sort: q.sort,
        dir: q.dir,
        q: q.q || undefined,
        actor: q.actor || undefined,
        action: q.action || undefined,
      });
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function pushUrl() {
    const query = qs({
      offset: q.offset || undefined,
      sort: q.sort !== 'createdAt' ? q.sort : undefined,
      dir: q.dir !== 'desc' ? q.dir : undefined,
      q: q.q || undefined,
      actor: q.actor || undefined,
      action: q.action || undefined,
    });
    void goto(`${PATH}${query}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  $effect(() => {
    void [q.offset, q.sort, q.dir, q.q, q.actor, q.action];
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

  function onFilter(): void {
    q.offset = 0;
    pushUrl();
  }

  const targetHref = (d: AuditEntry): string | null => {
    if (!d.target || !d.targetKind) return null;
    switch (d.targetKind) {
      case 'finding':
        return `/findings?finding=${d.target}`;
      case 'repository':
        return `/repositories/${d.target}/config`;
      case 'review':
        return `/reviews/${d.target}`;
      case 'action-plan':
        return '/inbox';
      case 'rule':
        return '/learnings';
    }
  };

  const columns = $derived<Column[]>([
    { key: 'actor', label: $LL.col.actor(), sortable: true },
    { key: 'action', label: $LL.col.action(), sortable: true },
    { key: 'target', label: $LL.col.target() },
    { key: 'createdAt', label: $LL.col.when(), sortable: true, align: 'end' },
  ]);
</script>

<PageHeader title={$LL.nav.audit()} />

<Section flush>
  <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
    <Input class="grow" placeholder={$LL.list.searchActor()} bind:value={search} oninput={onSearch} />
    <SelectField
      options={[{ value: '', label: $LL.audit.allActors() }, ...facets.actors.map((a) => ({ value: a.id, label: a.label ?? a.id }))]}
      bind:value={q.actor}
      onchange={onFilter}
    />
    <SelectField
      options={[{ value: '', label: $LL.audit.allActions() }, ...facets.actions.map((a) => ({ value: a, label: a }))]}
      bind:value={q.action}
      onchange={onFilter}
    />
  </div>

  <ListState {error} loading={!result} empty={result?.total === 0} skeletonColumns={columns.length}>
    {#if result}
      <DataTable {columns} items={result.items} rowKey={(d) => d.id} sort={q.sort} dir={q.dir} onSort={sortBy}>
        {#snippet row(d)}
          <Table.Cell>
            <span class="cell-strong">{d.actorLabel ?? d.actor ?? 'system'}</span>
            {#if d.actorLabel}<span class="cell-sub">{d.actor}</span>{/if}
          </Table.Cell>
          <Table.Cell><code>{d.action}</code></Table.Cell>
          <Table.Cell class="cell-name">
            {#if targetHref(d)}
              <a class="clamp-2" href={targetHref(d)}>{d.targetLabel}</a>
              <span class="cell-sub">{enumLabel($LL, 'auditTarget', d.targetKind)}</span>
            {:else}
              <span class="text-muted-foreground">{d.target ?? '—'}</span>
            {/if}
          </Table.Cell>
          <Table.Cell class="text-muted-foreground text-right">{formatDateTime(d.createdAt, $locale)}</Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </ListState>
  {#if result}
    <div class="border-t px-4 py-3"><Pagination offset={result.offset} limit={result.limit} total={result.total} onpage={onPage} /></div>
  {/if}
</Section>

