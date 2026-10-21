<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, type GlobalLearningRow } from '$lib/api';
  import { qs } from '$lib/paging';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import { me } from '$lib/me';

  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { platformTabs } from '$lib/tabs';
  import EmptyState from '$lib/components/EmptyState.svelte';
  const LIMIT = 50;
  const PATH = $page.url.pathname;
  const sp = $page.url.searchParams;
  const STATUSES = ['proposed', 'approved', 'rejected', 'revoked', 'expired'];

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rows = $state<GlobalLearningRow[]>([]);
  let total = $state(0);
  let actionMsg = $state('');
  let expanded = $state<Record<string, boolean>>({});

  let q = $state({ offset: Number(sp.get('offset') ?? 0) || 0, status: sp.get('status') ?? '', q: sp.get('q') ?? '' });
  let search = $state(sp.get('q') ?? '');

  let pInstruction = $state('');
  let pRationale = $state('');
  let pLocality = $state('none');
  let pSelector = $state('');
  let pEnforcement = $state('default');
  let pExpires = $state('');
  const today = new Date().toISOString().slice(0, 10);
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const res = await api.globalLearnings({ limit: LIMIT, offset: q.offset, status: q.status || undefined, q: q.q || undefined });
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

  async function act(id: string, action: 'approve' | 'reject' | 'revoke'): Promise<void> {
    actionMsg = '';
    try {
      await api.globalLearningAction(id, action);
      await load();
    } catch (e) {
      actionMsg = (e as Error).message;
    }
  }

  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function propose(): Promise<void> {
    await api.proposeGlobalLearning({
      instruction: pInstruction,
      rationale: pRationale,
      locality: pLocality,
      ...(pSelector ? { selector: pSelector } : {}),
      enforcement: pEnforcement,
      ...(pExpires ? { expiresAt: `${pExpires}T23:59:59.000Z` } : {}),
    });
    pInstruction = '';
    pRationale = '';
    pSelector = '';
    pExpires = '';
    await load();
  }

  function pct(c?: number): string {
    return c === undefined ? '—' : `${Math.round(c * 100)}%`;
  }
</script>

<PageHeader tabs={platformTabs($LL)}>
  {#snippet actions()}
    <AddDialog
      title={$LL.globalLearnings.proposeTitle()}
      submitLabel={$LL.globalLearnings.submit()}
      canSubmit={Boolean(pInstruction && pRationale)}
      onsubmit={propose}
    >
      <FormField label={$LL.globalLearnings.instruction()}><Input bind:value={pInstruction} /></FormField>
      <FormField label={$LL.globalLearnings.rationale()}><Input bind:value={pRationale} /></FormField>
      <FormField label={$LL.col.scope()}>
        <SelectField options={[{ value: 'none', label: 'none' }, { value: 'path', label: 'path' }]} bind:value={pLocality} />
      </FormField>
      {#if pLocality === 'path'}
        <FormField label={$LL.globalLearnings.selector()}><Input bind:value={pSelector} placeholder="src/**" /></FormField>
      {/if}
      <FormField label={$LL.globalLearnings.enforcement()}>
        <SelectField options={[{ value: 'default', label: 'default' }, { value: 'mandatory', label: 'mandatory' }]} bind:value={pEnforcement} />
      </FormField>
      <FormField label={$LL.learnings.expiresAt()} hint={$LL.learnings.expiresHint()}><Input type="date" min={today} bind:value={pExpires} /></FormField>
    </AddDialog>
  {/snippet}
</PageHeader>
{#if $me && !$me.isOperator}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
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
    <SelectField options={[...STATUSES.map((s) => ({ value: String(s), label: String(s) })), { value: '', label: `${$LL.list.all()} · ${$LL.col.status()}` }]} bind:value={q.status} onchange={onFilter} />
  </div>

  {#if total === 0}
    <EmptyState title={$LL.list.empty()} />
  {:else}
    <ul class="border-border divide-border divide-y rounded-lg border">
      {#each rows as l (l.id)}
        <li class="p-4 sm:p-5">
          <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <p class="m-0 min-w-0 flex-1 text-[15px] leading-snug font-semibold">{l.instruction}</p>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              {#if l.origin === 'auto'}<Badge value={$LL.globalLearnings.auto()} tone="accent" />{/if}
              {#if l.enforcement === 'mandatory'}<Badge value="mandatory" tone="accent" />{/if}
              <Badge value={l.status} />
            </div>
          </div>

          {#if l.rationale}
            <p class="text-muted-foreground mt-1.5 mb-0 max-w-[76ch] text-sm leading-relaxed">{l.rationale}</p>
          {/if}

          <div class="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span><code class="text-[11px]">{l.locality}{l.selector ? ` (${l.selector})` : ''}</code></span>
            <span>{$LL.globalLearnings.by()} {l.proposedBy} · v{l.version}</span>
            {#if l.expiresAt}<span class="tabular-nums">{l.expiresAt <= Date.now() ? $LL.learnings.expired() : $LL.learnings.expires()} {day(l.expiresAt)}</span>{/if}
            {#if l.confidence !== undefined}
              <span class="tabular-nums">{$LL.globalLearnings.confidence()} {pct(l.confidence)}</span>
            {/if}
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            {#if l.status === 'proposed'}
              <Button size="sm" type="button" onclick={() => act(l.id, 'approve')}>{$LL.common.approve()}</Button>
              <Button size="sm" variant="ghost" type="button" onclick={() => act(l.id, 'reject')}>
                {$LL.globalLearnings.reject()}
              </Button>
            {:else if l.status === 'approved'}
              <Button size="sm" variant="outline" type="button" onclick={() => act(l.id, 'revoke')}>
                {$LL.globalLearnings.revoke()}
              </Button>
            {/if}
            {#if l.deliberation}
              <Button size="sm" variant="ghost" type="button" onclick={() => (expanded[l.id] = !expanded[l.id])}>
                {$LL.globalLearnings.details()}
              </Button>
            {/if}
          </div>

          {#if l.deliberation && expanded[l.id]}
            <div class="border-border mt-4 border-l-2 pl-4">
              <dl class="m-0 grid gap-1 text-xs">
                {#if l.deliberation.signal}
                  <div class="flex gap-2">
                    <dt class="text-muted-foreground shrink-0">{$LL.globalLearnings.signal()}</dt>
                    <dd class="m-0">{l.deliberation.signal.kind} — {l.deliberation.signal.note}</dd>
                  </div>
                {/if}
                <div class="flex gap-2">
                  <dt class="text-muted-foreground shrink-0">{$LL.globalLearnings.draftModel()}</dt>
                  <dd class="m-0"><code class="text-[11px]">{l.deliberation.draftModel}</code></dd>
                </div>
              </dl>

              {#if l.deliberation.evidence.length > 0}
                <p class="eyebrow mt-3 mb-1">{$LL.col.evidence()}</p>
                <ul class="text-muted-foreground m-0 list-disc pl-4 text-xs">
                  {#each l.deliberation.evidence as ev, i (i)}<li>{ev}</li>{/each}
                </ul>
              {/if}

              <p class="eyebrow mt-3 mb-1">
                {$LL.globalLearnings.panel()}
                <span class="tabular-nums">
                  {l.deliberation.aggregate.approvals}/{l.deliberation.aggregate.total} · {pct(
                    l.deliberation.aggregate.confidence,
                  )}
                </span>
              </p>
              <ul class="divide-border m-0 list-none divide-y p-0">
                {#each l.deliberation.panel as v (v.model)}
                  <li class="py-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <code class="text-[11px]">{v.model}</code>
                      <Badge value={v.decision} tone={v.decision === 'approve' ? 'accent' : undefined} />
                      <span class="text-muted-foreground ml-auto text-xs tabular-nums">
                        {$LL.globalLearnings.confidence()} {pct(v.confidence)}
                      </span>
                    </div>
                    <p class="text-muted-foreground mt-1 mb-0 max-w-[76ch] text-xs">{v.reasoning}</p>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <Pagination offset={q.offset} limit={LIMIT} total={total} onpage={onPage} />
  {/if}
{/if}
