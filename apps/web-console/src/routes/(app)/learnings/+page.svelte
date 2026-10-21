<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import { api, type GlobalLearningsPolicy, type Repository, type RuleRow, type RuleScope } from '$lib/api';
  import { me, roleAtLeast } from '$lib/me';
  import { qs, type Paged } from '$lib/paging';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDate } from '$lib/format';
  import { notifyInboxChanged } from '$lib/inbox';
  import ListState from '$lib/components/ListState.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import SelectField from '$lib/components/SelectField.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';

  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;
  const SCOPES: ('' | RuleScope)[] = ['', 'repository', 'organization', 'user', 'platform'];

  let q = $state({ offset: Number(sp.get('offset') ?? 0) || 0, scope: sp.get('scope') ?? '', state: sp.get('state') ?? '', q: sp.get('q') ?? '' });
  let search = $state(sp.get('q') ?? '');
  let result = $state<(Paged<RuleRow> & { counts: Record<'all' | RuleScope, number> }) | null>(null);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      result = await api.rules({ limit: LIMIT, offset: q.offset, scope: q.scope || undefined, state: q.state || undefined, q: q.q || undefined });
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function pushUrl(): void {
    const query = qs({ offset: q.offset || undefined, scope: q.scope || undefined, state: q.state || undefined, q: q.q || undefined });
    void goto(`${PATH}${query}`, { replaceState: true, keepFocus: true, noScroll: true });
  }
  $effect(() => {
    void [q.offset, q.scope, q.state, q.q];
    void load();
  });
  let timer: ReturnType<typeof setTimeout>;
  function onSearch(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q.q = search.trim();
      q.offset = 0;
      pushUrl();
    }, 300);
  }
  function onFilter(): void {
    q.offset = 0;
    pushUrl();
  }

  const canApprove = $derived(roleAtLeast($me?.role, 'admin'));

  async function act(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      notifyInboxChanged();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  let policy = $state<GlobalLearningsPolicy>('prompt');
  api
    .globalLearningsPolicy()
    .then((p) => (policy = p.policy))
    .catch(() => undefined);
  async function savePolicy(next: GlobalLearningsPolicy): Promise<void> {
    await act(async () => (policy = (await api.saveGlobalLearningsPolicy(next)).policy));
  }

  const scopeLabel = (s: '' | RuleScope): string =>
    s === 'repository'
      ? $LL.rules.scopeRepository()
      : s === 'organization'
        ? $LL.rules.scopeOrganization()
        : s === 'user'
          ? $LL.rules.scopeUser()
          : s === 'platform'
            ? $LL.rules.scopePlatform()
            : $LL.rules.scopeAll();
  const statusLabel = (s: string): string => ($LL.rules.status as unknown as Record<string, () => string>)[s]?.() ?? s;

  // Manual proposals still go through approval.
  let fInstruction = $state('');
  let fRationale = $state('');
  let fBroadness = $state('repository');
  let fRepoQuery = $state('');
  let fRepoOptions = $state<Repository[]>([]);
  let fRepositoryId = $state('');
  let fSubjectRef = $state('');
  let fLocality = $state('none');
  let fSelector = $state('');
  let fExpires = $state('');
  const today = new Date().toISOString().slice(0, 10);
  let repoTimer: ReturnType<typeof setTimeout>;
  async function findRepos(): Promise<void> {
    try {
      fRepoOptions = (await api.repositories({ limit: 20, q: fRepoQuery.trim() || undefined })).items;
      if (!fRepoOptions.some((r) => r.id === fRepositoryId)) fRepositoryId = fRepoOptions[0]?.id ?? '';
    } catch {
      fRepoOptions = [];
    }
  }
  void findRepos();
  function onRepoQuery(): void {
    clearTimeout(repoTimer);
    repoTimer = setTimeout(() => void findRepos(), 250);
  }
  const canPropose = $derived(
    Boolean(fInstruction.trim() && fRationale.trim()) &&
      (fBroadness !== 'repository' || Boolean(fRepositoryId)) &&
      (fBroadness !== 'user' || /^[a-z]+:\d+$/.test(fSubjectRef.trim())) &&
      (fLocality === 'none' || Boolean(fSelector.trim())),
  );
  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function propose(): Promise<void> {
    await api.proposeLearning({
      instruction: fInstruction.trim(),
      rationale: fRationale.trim(),
      broadness: fBroadness,
      ...(fBroadness === 'repository' ? { repositoryId: fRepositoryId } : {}),
      ...(fBroadness === 'user' ? { subjectRef: fSubjectRef.trim() } : {}),
      locality: fLocality,
      ...(fLocality !== 'none' ? { selector: fSelector.trim() } : {}),
      ...(fExpires ? { expiresAt: `${fExpires}T23:59:59.000Z` } : {}),
    });
    fInstruction = '';
    fRationale = '';
    fSelector = '';
    fExpires = '';
    await load();
  }

</script>

<PageHeader title={$LL.nav.learnings()}>
  {#snippet actions()}
    <AddDialog title={$LL.learnings.addTitle()} submitLabel={$LL.learnings.submit()} canSubmit={canPropose} onsubmit={propose}>
      <FormField label={$LL.learnings.instruction()}><Textarea rows={3} bind:value={fInstruction} /></FormField>
      <FormField label={$LL.learnings.rationale()}><Input bind:value={fRationale} /></FormField>
      <FormField label={$LL.learnings.scope()}>
        <SelectField
          options={[
            { value: 'repository', label: String($LL.learnings.broadRepository()) },
            ...(canApprove ? [{ value: 'organization', label: String($LL.learnings.broadOrganization()) }] : []),
            { value: 'user', label: String($LL.learnings.broadUser()) },
          ]}
          bind:value={fBroadness}
        />
      </FormField>
      {#if fBroadness === 'repository'}
        <FormField label={$LL.col.repository()}>
          <Input placeholder={$LL.list.search()} bind:value={fRepoQuery} oninput={onRepoQuery} />
          <SelectField options={fRepoOptions.map((r) => ({ value: r.id, label: `${r.namespace}/${r.name}` }))} bind:value={fRepositoryId} />
        </FormField>
      {:else if fBroadness === 'user'}
        <FormField label={$LL.learnings.subjectRef()} hint={$LL.learnings.subjectRefHint()}><Input bind:value={fSubjectRef} placeholder="github:12345" /></FormField>
      {/if}
      <FormField label={$LL.learnings.locality()}>
        <SelectField options={[{ value: 'none', label: String($LL.learnings.localityNone()) }, { value: 'path', label: String($LL.learnings.localityPath()) }]} bind:value={fLocality} />
      </FormField>
      {#if fLocality === 'path'}
        <FormField label={$LL.learnings.selector()}><Input bind:value={fSelector} placeholder="src/**" /></FormField>
      {/if}
      <FormField label={$LL.learnings.expiresAt()} hint={$LL.learnings.expiresHint()}><Input type="date" min={today} bind:value={fExpires} /></FormField>
    </AddDialog>
  {/snippet}
</PageHeader>

<div class="rules-bar">
  <Tabs.Root value={q.scope || 'all'} onValueChange={(v) => ((q.scope = v === 'all' ? '' : v), onFilter())}>
    <Tabs.List>
      {#each SCOPES as s (s)}
        <Tabs.Trigger value={s || 'all'}>
          {scopeLabel(s)}{#if result}<span class="rules-count">{result.counts[s || 'all']}</span>{/if}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
  </Tabs.Root>
  <div class="rules-filters">
    <Input placeholder={$LL.list.search()} bind:value={search} oninput={onSearch} />
    <SelectField
      options={[
        { value: '', label: $LL.rules.stateAll() },
        { value: 'proposed', label: $LL.rules.stateProposed() },
        { value: 'active', label: $LL.rules.stateActive() },
        { value: 'inactive', label: $LL.rules.stateInactive() },
      ]}
      bind:value={q.state}
      onchange={onFilter}
    />
  </div>
</div>

{#if q.scope === 'platform' && canApprove}
  <div class="settings-notice">
    <span class="flex-1">{$LL.rules.policyHint()}</span>
    <SelectField
      class="w-48"
      options={[
        { value: 'prompt', label: $LL.glAdoption.policyPrompt() },
        { value: 'auto_accept', label: $LL.glAdoption.policyAutoAccept() },
        { value: 'ignore', label: $LL.glAdoption.policyIgnore() },
      ]}
      value={policy}
      onchange={(v) => savePolicy(v as GlobalLearningsPolicy)}
    />
  </div>
{/if}

<Section flush>
  <ListState {error} loading={!result} empty={result?.total === 0}>
    {#if result}
      <ul class="rules-list">
        {#each result.items as r (r.id)}
          <li class={['rule-row', r.state === 'inactive' && 'muted']}>
            <div class="rule-main">
              <p class="rule-text">{r.instruction}</p>
              {#if r.rationale}<p class="rule-why">{r.rationale}</p>{/if}
              <div class="rule-meta">
                <span class={['rule-scope', r.scope === 'platform' && 'platform']}>
                  {r.repositories.length ? r.repositories.join(', ') : scopeLabel(r.scope)}
                </span>
                {#if r.selector}<code>{r.selector}</code>{/if}
                <span class={['rule-status', `state-${r.state}`]}>{statusLabel(r.status)}</span>
                {#if r.expiresAt}<span>{$LL.rules.expires({ date: formatDate(r.expiresAt, $locale) })}</span>{/if}
                {#if r.usageCount !== null}
                  <span>{r.usageCount ? $LL.rules.used({ n: r.usageCount }) : $LL.rules.neverUsed()}</span>
                {/if}
                <span class="ml-auto">{formatDate(r.createdAt, $locale)}</span>
              </div>
            </div>
            {#if canApprove}
              <div class="rule-actions">
                {#if r.scope !== 'platform' && r.status === 'proposed'}
                  <Button size="sm" onclick={() => act(() => api.learningAction(r.id, 'approve'))}>{$LL.common.approve()}</Button>
                  <Button size="sm" variant="ghost" onclick={() => act(() => api.learningAction(r.id, 'reject'))}>{$LL.learnings.reject()}</Button>
                {:else if r.scope !== 'platform' && r.status === 'approved'}
                  <Button size="sm" variant="outline" onclick={() => act(() => api.learningAction(r.id, 'revoke'))}>{$LL.learnings.revoke()}</Button>
                {:else if r.status === 'recommended' || r.status === 'declined'}
                  <Button size="sm" onclick={() => act(() => api.adoptGlobalLearning(r.id))}>{$LL.glAdoption.adoptOrg()}</Button>
                  {#if r.status === 'recommended'}
                    <Button size="sm" variant="ghost" onclick={() => act(() => api.declineGlobalLearning(r.id))}>{$LL.glAdoption.decline()}</Button>
                  {/if}
                {:else if r.status === 'adopted'}
                  <Button size="sm" variant="ghost" onclick={() => act(() => api.declineGlobalLearning(r.id))}>{$LL.glAdoption.decline()}</Button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </ListState>
  {#if result && result.total > LIMIT}
    <div class="border-t px-4 py-3">
      <Pagination offset={result.offset} limit={result.limit} total={result.total} onpage={(o) => ((q.offset = o), pushUrl())} />
    </div>
  {/if}
</Section>
