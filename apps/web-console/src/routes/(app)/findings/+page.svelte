<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type FindingRow, type Repository, type SuppressedRow } from '$lib/api';
  import { qs, nextSort, type Paged, type SortDir } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatRelativeTime } from '$lib/format';
  import { enumLabel, severityLabel } from '$lib/labels';
  import Pagination from '$lib/components/Pagination.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import ListState from '$lib/components/ListState.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  import FindingInspector from '$lib/components/FindingInspector.svelte';

  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;

  let q = $state({
    offset: Number(sp.get('offset') ?? 0) || 0,
    sort: sp.get('sort') ?? 'severity',
    dir: (sp.get('dir') as SortDir) ?? 'asc',
    status: sp.get('status') ?? 'open',
    repositoryId: sp.get('repositoryId') ?? '',
    severity: sp.get('severity') ?? '',
  });
  const selected = $derived($page.url.searchParams.get('finding'));

  let findings = $state<Paged<FindingRow> | null>(null);
  let suppressed = $state<Paged<SuppressedRow> | null>(null);
  let error = $state<string | null>(null);
  let repos = $state<Repository[]>([]);

  api
    .repositories({ limit: 200, sort: 'namespace', dir: 'asc' })
    .then((r) => (repos = r.items))
    .catch(() => (repos = []));

  const isSuppressed = $derived(q.status === 'suppressed');

  async function load(): Promise<void> {
    error = null;
    try {
      if (isSuppressed) {
        suppressed = await api.suppressed({ limit: LIMIT, offset: q.offset, repositoryId: q.repositoryId || undefined });
      } else {
        findings = await api.findings({
          limit: LIMIT,
          offset: q.offset,
          sort: q.sort,
          dir: q.dir,
          status: q.status,
          repositoryId: q.repositoryId || undefined,
          severity: q.severity || undefined,
        });
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function pushUrl(finding?: string | null): void {
    const query = qs({
      offset: q.offset || undefined,
      sort: q.sort !== 'severity' ? q.sort : undefined,
      dir: q.dir !== 'asc' ? q.dir : undefined,
      status: q.status !== 'open' ? q.status : undefined,
      repositoryId: q.repositoryId || undefined,
      severity: q.severity || undefined,
      finding: finding === undefined ? (selected ?? undefined) : (finding ?? undefined),
    });
    void goto(`${PATH}${query}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  $effect(() => {
    void [q.offset, q.sort, q.dir, q.status, q.repositoryId, q.severity];
    void load();
  });

  function onFilter(): void {
    q.offset = 0;
    pushUrl(null);
  }
  function sortBy(field: string): void {
    const s = nextSort({ sort: q.sort, dir: q.dir }, field);
    q.sort = s.sort;
    q.dir = s.dir;
    q.offset = 0;
    pushUrl();
  }

  const columns = $derived<Column[]>([
    { key: 'severity', label: $LL.fnd.colSeverity(), sortable: true },
    { key: 'claim', label: $LL.fnd.colClaim() },
    { key: 'change', label: $LL.rv.colChange() },
    { key: 'state', label: isSuppressed ? $LL.fnd.colReason() : $LL.fnd.colState() },
    { key: 'occurrences', label: $LL.fnd.colRounds(), sortable: !isSuppressed, align: 'end' },
    { key: 'lastSeenAt', label: $LL.fnd.colLastSeen(), sortable: !isSuppressed, align: 'end' },
  ]);
  const result = $derived(isSuppressed ? suppressed : findings);
  const repoShort = (r: string): string => r.split('/').pop() ?? r;
</script>

<PageHeader title={$LL.nav.findings()}>
  {#snippet actions()}
    <SelectField
      options={[{ value: '', label: String($LL.list.allRepositories()) }, ...repos.map((r) => ({ value: r.id, label: `${r.namespace}/${r.name}` }))]}
      bind:value={q.repositoryId}
      onchange={onFilter}
    />
    <Tabs.Root value={q.status} onValueChange={(v) => ((q.status = v), onFilter())}>
      <Tabs.List>
        <Tabs.Trigger value="open">{$LL.fnd.open()}</Tabs.Trigger>
        <Tabs.Trigger value="resolved">{$LL.fnd.resolved()}</Tabs.Trigger>
        <Tabs.Trigger value="dismissed">{$LL.fnd.dismissed()}</Tabs.Trigger>
        <Tabs.Trigger value="suppressed">{$LL.fnd.suppressed()}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/snippet}
</PageHeader>

<div class={['with-insp', selected && 'open']}>
  <div class="min-w-0 flex-1">
    <Section flush>
      <ListState {error} loading={!result} empty={result?.total === 0} skeletonColumns={columns.length}>
        {#if isSuppressed && suppressed}
          <DataTable {columns} items={suppressed.items} rowKey={(r) => `${r.findingId}:${r.revisionId}`} onRowClick={(r) => goto(`/reviews/${r.revisionId}?finding=${r.findingId}`)}>
            {#snippet row(r)}
              <Table.Cell><span class={`sev-text-${r.severity}`}>{severityLabel($LL, r.severity)}</span></Table.Cell>
              <Table.Cell class="cell-name"><span class="clamp-2">{r.claim}</span></Table.Cell>
              <Table.Cell class="text-muted-foreground">{repoShort(r.repository)} #{r.changeNumber}</Table.Cell>
              <Table.Cell class="text-muted-foreground">{r.reason ? enumLabel($LL, 'suppress', r.reason) : '—'}</Table.Cell>
              <Table.Cell class="text-muted-foreground text-right">1</Table.Cell>
              <Table.Cell class="text-muted-foreground text-right">{formatRelativeTime(r.createdAt, $locale)}</Table.Cell>
            {/snippet}
          </DataTable>
        {:else if findings}
          <DataTable
            {columns}
            items={findings.items}
            rowKey={(r) => r.id}
            sort={q.sort}
            dir={q.dir}
            onSort={sortBy}
            selectedKey={selected}
            onRowClick={(r) => pushUrl(selected === r.id ? null : r.id)}
          >
            {#snippet row(r)}
              <Table.Cell><span class={`sev-text-${r.severity}`}>{severityLabel($LL, r.severity)}</span></Table.Cell>
              <Table.Cell class="cell-name"><span class="clamp-2">{r.claim}</span></Table.Cell>
              <Table.Cell class="text-muted-foreground">{repoShort(r.repository)}{r.changeNumber !== null ? ` #${r.changeNumber}` : ''}</Table.Cell>
              <Table.Cell>{enumLabel($LL, 'lifecycle', r.lifecycle)}</Table.Cell>
              <Table.Cell class="text-muted-foreground text-right tabular-nums">{r.occurrenceCount}</Table.Cell>
              <Table.Cell class="text-muted-foreground text-right">{formatRelativeTime(r.lastSeenAt, $locale)}</Table.Cell>
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
  </div>

  {#if selected}
    <FindingInspector findingId={selected} onclose={() => pushUrl(null)} onchange={load} />
  {/if}
</div>
