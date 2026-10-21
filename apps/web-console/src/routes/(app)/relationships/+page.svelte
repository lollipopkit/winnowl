<script lang="ts">
  import { api, type RelationshipRow, type Repository } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import Badge from '$lib/components/Badge.svelte';

  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { repoTabs } from '$lib/tabs';
  import Section from '$lib/components/Section.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  const KINDS = ['api-provider', 'api-consumer', 'shared-schema', 'generated-client', 'library-dependent', 'deployment-dependent'];

  let rows = $state<RelationshipRow[] | null>(null);
  let repos = $state<Repository[]>([]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let notice = $state<string | null>(null);

  let srcId = $state('');
  let tgtId = $state('');
  let kind = $state('api-provider');
  let instructions = $state('');

  const repoName = $derived(new Map(repos.map((r) => [r.id, `${r.namespace}/${r.name}`])));
  const repoOptions = $derived(repos.map((r) => ({ value: String(r.id), label: `${r.namespace}/${r.name}` })));
  const proposed = $derived((rows ?? []).filter((r) => r.status === 'proposed'));
  const active = $derived((rows ?? []).filter((r) => r.status === 'active'));

  async function reload(): Promise<void> {
    error = null;
    try {
      const [rels, repoPage] = await Promise.all([api.relationships(), api.repositories({ limit: 200 })]);
      rows = rels;
      repos = repoPage.items;
    } catch (e) {
      error = String(e);
    }
  }
  void reload();

  async function run(op: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = null;
    notice = null;
    try {
      await op();
      await reload();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function discover(): Promise<void> {
    await run(async () => {
      await api.discoverRelationships();
      notice = $LL.relationships.discoverQueued();
    });
  }

  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function create(): Promise<void> {
    await api.createRelationship({ sourceRepositoryId: srcId, targetRepositoryId: tgtId, kind, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) });
    srcId = '';
    tgtId = '';
    kind = 'api-provider';
    instructions = '';
    await reload();
  }

  function name(id: string): string {
    return repoName.get(id) ?? id;
  }
</script>

<PageHeader tabs={repoTabs($LL)}>
  {#snippet actions()}
    <AddDialog
      title={$LL.relationships.add()}
      submitLabel={$LL.relationships.create()}
      canSubmit={Boolean(srcId && tgtId && srcId !== tgtId)}
      onsubmit={create}
    >
      <SelectField options={repoOptions} placeholder={String($LL.relationships.sourceRepo())} bind:value={srcId} />
      <SelectField options={repoOptions} placeholder={String($LL.relationships.targetRepo())} bind:value={tgtId} />
      <SelectField options={KINDS.map((k) => ({ value: k, label: k }))} bind:value={kind} />
      <Input type="text" placeholder={$LL.relationships.instructionsPlaceholder()} bind:value={instructions} />
    </AddDialog>
  {/snippet}
</PageHeader>
{#if error}<ErrorText message={error} />{/if}
{#if notice}
  <Alert.Root class="mb-5"><Alert.Description>{notice}</Alert.Description></Alert.Root>
{/if}

{#if rows === null}
  <Loading />
{:else}
  {#if proposed.length > 0}
    <Section title="{$LL.relationships.inbox()} ({proposed.length})" flush>
      <ul class="divide-border m-0 list-none divide-y p-0">
        {#each proposed as p (p.id)}
          <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4">
            <div class="min-w-0 flex-1">
              <p class="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold">
                {name(p.sourceRepositoryId)}
                <span class="text-muted-foreground" aria-hidden="true">→</span>
                {name(p.targetRepositoryId)}
                <Badge value={p.kind} />
              </p>
              {#if p.rationale}
                <p class="text-muted-foreground mt-1.5 mb-0 max-w-[76ch] text-sm">{p.rationale}</p>
              {/if}
              {#if p.proposedBy}
                <p class="text-muted-foreground mt-1.5 mb-0 text-xs">
                  {$LL.relationships.proposedBy({ by: p.proposedBy })}
                </p>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Button size="sm" disabled={busy} onclick={() => run(() => api.transitionRelationship(p.id, 'approve'))}>
                {$LL.common.approve()}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onclick={() => run(() => api.transitionRelationship(p.id, 'reject'))}
              >
                {$LL.common.reject()}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    </Section>
  {/if}

  <Section title={$LL.relationships.activeList()} flush>
    {#snippet actions()}
      <Button variant="outline" size="sm" disabled={busy} onclick={discover}>{$LL.relationships.discover()}</Button>
    {/snippet}
    {#if active.length === 0}
      <div class="px-5"><EmptyState title={$LL.relationships.none()} compact /></div>
    {:else}
      <ul class="divide-border m-0 list-none divide-y p-0">
        {#each active as r (r.id)}
          <li class={['flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4', !r.enabled && 'opacity-60']}>
            <div class="min-w-0 flex-1">
              <p class="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold">
                {name(r.sourceRepositoryId)}
                <span class="text-muted-foreground" aria-hidden="true">→</span>
                {name(r.targetRepositoryId)}
                <Badge value={r.kind} />
                {#if !r.enabled}<Badge value={$LL.relationships.disabled()} tone="warn" />{/if}
              </p>
              {#if r.instructions}
                <p class="text-muted-foreground mt-1.5 mb-0 max-w-[76ch] text-sm">{r.instructions}</p>
              {/if}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onclick={() => run(() => api.toggleRelationship(r.id, !r.enabled))}
            >
              {r.enabled ? $LL.relationships.disable() : $LL.relationships.enable()}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>

{/if}
