<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type EcosystemFactRow, type FactFeedRow } from '$lib/api';
  import Section from '$lib/components/Section.svelte';
  import { qs } from '$lib/paging';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import { me } from '$lib/me';
  import { platformTabs } from '$lib/tabs';

  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import FormDialog from '$lib/components/FormDialog.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';

  // Approved facts are injected into every tenant's reviews by repository dependency.
  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;
  const STATUSES = ['proposed', 'approved', 'rejected'];
  const ECOSYSTEMS = ['npm', 'pypi', 'cargo', 'go', 'pub', 'maven', 'rubygems', 'nuget', 'composer', 'hex', 'other'];

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rows = $state<EcosystemFactRow[]>([]);
  let total = $state(0);
  let actionMsg = $state('');

  let q = $state({ offset: Number(sp.get('offset') ?? 0) || 0, status: sp.get('status') ?? '', q: sp.get('q') ?? '' });
  let search = $state(sp.get('q') ?? '');

  // Manually added facts are approved on creation.
  let fEcosystem = $state('pub');
  let fSubject = $state('');
  let fVersions = $state('');
  let fClaim = $state('');
  let fDetail = $state('');
  let fSources = $state('');
  let fExpires = $state('');

  // Edit-then-approve: empty versions/detail clear the field (matches backend semantics).
  let rSubject = $state('');
  let rVersions = $state('');
  let rClaim = $state('');
  let rDetail = $state('');
  let rExpires = $state('');

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const res = await api.ecosystemFacts({ limit: LIMIT, offset: q.offset, status: q.status || undefined, q: q.q || undefined });
      rows = res.items;
      total = res.total;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void [q.offset, q.status, q.q];
    void load();
  });
  function pushUrl() {
    void goto(`${PATH}${qs({ offset: q.offset || undefined, status: q.status || undefined, q: q.q || undefined })}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  let timer: ReturnType<typeof setTimeout>;
  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q.q = search.trim();
      q.offset = 0;
      pushUrl();
    }, 300);
  }
  function onFilter() {
    q.offset = 0;
    pushUrl();
  }
  function onPage(offset: number) {
    q.offset = offset;
    pushUrl();
  }

  const forbidden = $derived(loadError !== null && loadError.startsWith('403'));
  const sourceList = $derived(fSources.split('\n').map((s) => s.trim()).filter(Boolean));

  /** End of the given day in UTC; undefined lets the backend apply its default expiry. */
  const endOfDay = (d: string): string | undefined => (d ? `${d}T23:59:59.000Z` : undefined);
  const today = new Date().toISOString().slice(0, 10);

  function openReview(f: EcosystemFactRow): void {
    rSubject = f.subject;
    rVersions = f.versions ?? '';
    rClaim = f.claim;
    rDetail = f.detail ?? '';
    rExpires = f.expiresAt ? f.expiresAt.slice(0, 10) : '';
  }

  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function approveEdited(id: string): Promise<void> {
    const expiresAt = endOfDay(rExpires);
    await api.ecosystemFactAction(id, 'approve', {
      subject: rSubject.trim(),
      claim: rClaim.trim(),
      versions: rVersions.trim(),
      detail: rDetail.trim(),
      ...(expiresAt ? { expiresAt } : {}),
    });
    await load();
  }

  async function act(id: string, action: 'approve' | 'reject'): Promise<void> {
    actionMsg = '';
    try {
      await api.ecosystemFactAction(id, action);
      await load();
    } catch (e) {
      actionMsg = (e as Error).message;
    }
  }

  async function add(): Promise<void> {
    await api.addEcosystemFact({
      ecosystem: fEcosystem,
      subject: fSubject,
      ...(fVersions ? { versions: fVersions } : {}),
      claim: fClaim,
      ...(fDetail ? { detail: fDetail } : {}),
      sources: sourceList,
      ...(endOfDay(fExpires) ? { expiresAt: endOfDay(fExpires) } : {}),
    });
    fSubject = '';
    fVersions = '';
    fClaim = '';
    fDetail = '';
    fSources = '';
    fExpires = '';
    await load();
  }

  const day = (iso?: string): string => (iso ? iso.slice(0, 10) : '—');

  // Release-notes feeds: the runner reads them every 7 days and extracted facts enter the same review queue.
  let feeds = $state<FactFeedRow[]>([]);
  let feedMsg = $state('');
  let feedEcosystem = $state('pub');
  let feedSubject = $state('');
  let feedUrl = $state('');
  let feedLabel = $state('');
  async function loadFeeds(): Promise<void> {
    try {
      feeds = (await api.factFeeds()).items;
    } catch {
      feeds = []; // 403 for non-operators
    }
  }
  void loadFeeds();
  async function addFeed(): Promise<void> {
    await api.addFactFeed({ ecosystem: feedEcosystem, subject: feedSubject.trim(), url: feedUrl.trim(), ...(feedLabel.trim() ? { label: feedLabel.trim() } : {}) });
    feedSubject = '';
    feedUrl = '';
    feedLabel = '';
    await loadFeeds();
  }
  async function feedAct(id: string, action: 'enable' | 'disable' | 'refresh' | 'delete'): Promise<void> {
    feedMsg = '';
    try {
      if (action === 'delete') await api.deleteFactFeed(id);
      else await api.factFeedAction(id, action);
      await loadFeeds();
    } catch (e) {
      feedMsg = (e as Error).message;
    }
  }
</script>

<PageHeader tabs={platformTabs($LL)}>
  {#snippet actions()}
    <AddDialog
      title={$LL.ecosystemFacts.addTitle()}
      submitLabel={$LL.ecosystemFacts.submit()}
      canSubmit={Boolean(fSubject && fClaim && sourceList.length > 0)}
      onsubmit={add}
    >
      <FormField label={$LL.ecosystemFacts.ecosystem()}>
        <SelectField options={ECOSYSTEMS.map((e) => ({ value: e, label: e }))} bind:value={fEcosystem} />
      </FormField>
      <FormField label={$LL.ecosystemFacts.subject()}><Input bind:value={fSubject} placeholder="material_ui" /></FormField>
      <FormField label={$LL.ecosystemFacts.versions()}><Input bind:value={fVersions} placeholder=">=1.0.0" /></FormField>
      <FormField label={$LL.ecosystemFacts.claim()}><Input bind:value={fClaim} /></FormField>
      <FormField label={$LL.ecosystemFacts.detail()}><Textarea rows={4} bind:value={fDetail} /></FormField>
      <FormField label={$LL.ecosystemFacts.sources()}><Textarea rows={3} bind:value={fSources} placeholder="https://" /></FormField>
      <FormField label={$LL.ecosystemFacts.expiresAt()} hint={$LL.ecosystemFacts.expiresHint()}><Input type="date" min={today} bind:value={fExpires} /></FormField>
    </AddDialog>
  {/snippet}
</PageHeader>
{#if $me && !$me.isOperator}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{/if}

{#if $me?.isOperator}
  <Section title={$LL.ecosystemFacts.feedsTitle()} description={$LL.ecosystemFacts.feedsHint()} flush>
    {#snippet actions()}
      <AddDialog
        title={$LL.ecosystemFacts.feedAddTitle()}
        submitLabel={$LL.ecosystemFacts.submit()}
        canSubmit={Boolean(feedSubject.trim() && /^https?:\/\//.test(feedUrl.trim()))}
        onsubmit={addFeed}
      >
        <FormField label={$LL.ecosystemFacts.ecosystem()}>
          <SelectField options={ECOSYSTEMS.map((e) => ({ value: e, label: e }))} bind:value={feedEcosystem} />
        </FormField>
        <FormField label={$LL.ecosystemFacts.subject()}><Input bind:value={feedSubject} placeholder="flutter" /></FormField>
        <FormField label={$LL.ecosystemFacts.feedUrl()}><Input bind:value={feedUrl} placeholder="https://docs.flutter.dev/release/breaking-changes" /></FormField>
        <FormField label={$LL.ecosystemFacts.feedLabel()}><Input bind:value={feedLabel} /></FormField>
      </AddDialog>
    {/snippet}
    {#if feedMsg}<div class="px-5 pt-4"><ErrorText message={feedMsg} /></div>{/if}
    {#if feeds.length === 0}
      <div class="px-5"><EmptyState title={$LL.ecosystemFacts.feedsEmpty()} compact /></div>
    {:else}
      <ul class="divide-border m-0 list-none divide-y p-0">
        {#each feeds as fd (fd.id)}
          <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-4">
            <div class="min-w-0 flex-1">
              <p class="m-0 text-sm font-semibold">{fd.label ?? fd.subject}</p>
              <p class="text-muted-foreground m-0 mt-0.5 truncate text-xs">
                <code class="text-[11px]">{fd.ecosystem}</code> · <code class="text-[11px]">{fd.subject}</code> ·
                <a href={fd.url} target="_blank" rel="noopener noreferrer nofollow">{fd.url}</a>
              </p>
              <p class="text-muted-foreground m-0 mt-1 text-xs tabular-nums">
                {$LL.ecosystemFacts.feedLastRun()} {day(fd.lastFetchedAt)}{#if fd.lastFetchedAt} · {$LL.ecosystemFacts.feedProposed({ n: fd.lastProposed })}{/if}
              </p>
              {#if fd.lastError}<p class="text-destructive m-0 mt-1 text-xs">{fd.lastError}</p>{/if}
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              {#if !fd.enabled}<Badge value={$LL.ecosystemFacts.feedDisabled()} />{/if}
              <Button size="sm" variant="ghost" type="button" onclick={() => feedAct(fd.id, 'refresh')}>{$LL.ecosystemFacts.feedRefresh()}</Button>
              <Button size="sm" variant="outline" type="button" onclick={() => feedAct(fd.id, fd.enabled ? 'disable' : 'enable')}>
                {fd.enabled ? $LL.ecosystemFacts.feedDisable() : $LL.ecosystemFacts.feedEnable()}
              </Button>
              <Button size="sm" variant="ghost" type="button" onclick={() => feedAct(fd.id, 'delete')}>{$LL.ecosystemFacts.feedDelete()}</Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>
{/if}

{#if loading && rows.length === 0}
  <Loading />
{:else if forbidden}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{:else if loadError}
  <ErrorText message={loadError} />
{:else}
  {#if actionMsg}<ErrorText message={actionMsg} />{/if}

  <div class="list-controls">
    <Input class="grow" placeholder={$LL.list.search()} bind:value={search} oninput={onSearch} />
    <SelectField options={[...STATUSES.map((s) => ({ value: s, label: s })), { value: '', label: `${$LL.list.all()} · ${$LL.col.status()}` }]} bind:value={q.status} onchange={onFilter} />
  </div>

  {#if total === 0}
    <EmptyState title={$LL.list.empty()} />
  {:else}
    <ul class="border-border divide-border divide-y rounded-lg border">
      {#each rows as f (f.id)}
        <li class="p-4 sm:p-5">
          <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div class="min-w-0 flex-1">
              <p class="text-muted-foreground m-0 text-xs">
                <code class="text-[11px]">{f.ecosystem}</code> · <code class="text-[11px]">{f.subject}</code>{#if f.versions}&nbsp;<code class="text-[11px]">{f.versions}</code>{/if}
              </p>
              <p class="mt-1 mb-0 text-[15px] leading-snug font-semibold">{f.claim}</p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <Badge
                value={f.origin === 'review' ? $LL.ecosystemFacts.fromReview() : f.origin === 'feed' ? $LL.ecosystemFacts.fromFeed() : $LL.ecosystemFacts.byOperator()}
                tone={f.origin === 'operator' ? undefined : 'accent'}
              />
              <Badge value={f.status} />
            </div>
          </div>

          {#if f.detail}
            <p class="text-muted-foreground mt-1.5 mb-0 max-w-[76ch] text-sm leading-relaxed whitespace-pre-line">{f.detail}</p>
          {/if}

          <ul class="m-0 mt-2 list-none p-0 text-xs">
            {#each f.sources as s (s)}
              <li class="truncate"><a href={s} target="_blank" rel="noopener noreferrer nofollow">{s}</a></li>
            {/each}
          </ul>

          <div class="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span class="tabular-nums">{$LL.ecosystemFacts.observed()} {day(f.observedAt)}</span>
            {#if f.expiresAt}<span class="tabular-nums">{$LL.ecosystemFacts.expires()} {day(f.expiresAt)}</span>{/if}
            {#if f.reviewedBy}<span>{$LL.ecosystemFacts.reviewedBy()} {f.reviewedBy}</span>{/if}
            {#if f.proposedFrom && 'revisionId' in f.proposedFrom}<span>revision <code class="text-[11px]">{f.proposedFrom.revisionId}</code></span>{/if}
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            {#if f.status === 'proposed'}
              <FormDialog
                title={$LL.ecosystemFacts.reviewTitle()}
                description={$LL.ecosystemFacts.reviewHint()}
                submitLabel={$LL.common.approve()}
                canSubmit={Boolean(rSubject.trim() && rClaim.trim())}
                onopen={() => openReview(f)}
                onsubmit={() => approveEdited(f.id)}
              >
                {#snippet trigger(show: () => void)}
                  <Button size="sm" type="button" onclick={show}>{$LL.common.approve()}</Button>
                {/snippet}
                <FormField label={$LL.ecosystemFacts.subject()}><Input bind:value={rSubject} /></FormField>
                <FormField label={$LL.ecosystemFacts.versions()}><Input bind:value={rVersions} placeholder=">=1.0.0" /></FormField>
                <FormField label={$LL.ecosystemFacts.claim()}><Textarea rows={2} bind:value={rClaim} /></FormField>
                <FormField label={$LL.ecosystemFacts.detail()}><Textarea rows={5} bind:value={rDetail} /></FormField>
                <FormField label={$LL.ecosystemFacts.expiresAt()} hint={$LL.ecosystemFacts.expiresHint()}><Input type="date" min={today} bind:value={rExpires} /></FormField>
              </FormDialog>
              <Button size="sm" variant="ghost" type="button" onclick={() => act(f.id, 'reject')}>{$LL.ecosystemFacts.reject()}</Button>
            {:else if f.status === 'approved'}
              <Button size="sm" variant="outline" type="button" onclick={() => act(f.id, 'reject')}>{$LL.ecosystemFacts.withdraw()}</Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <Pagination offset={q.offset} limit={LIMIT} total={total} onpage={onPage} />
  {/if}
{/if}
