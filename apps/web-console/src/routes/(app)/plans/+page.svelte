<script lang="ts">
  import { api, type CatalogEntryView, type PlatformPlanView, type RegisteredModelView, type UpstreamModel } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import FormField from '$lib/components/FormField.svelte';
  import { formatCompact, formatNumber, formatUsd } from '$lib/format';
  import Loading from '$lib/components/Loading.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import { me } from '$lib/me';

  import * as Table from '$lib/components/ui/table/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import Plus from '@lucide/svelte/icons/plus';
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let models = $state<RegisteredModelView[]>([]);
  let plans = $state<PlatformPlanView[]>([]);

  const fmtUsd = (n: number): string => formatUsd(n, $locale);
  let modelDialog = $state(false);
  // Gateway /v1/models list; on failure the dialog falls back to manual entry.
  let upstream = $state<UpstreamModel[]>([]);
  let upstreamError = $state<string | null>(null);
  // Registered models the gateway does not serve. Nothing is flagged unless the upstream list
  // actually loaded: "unknown" must not be reported as "missing".
  let upstreamLoaded = $state(false);
  const upstreamIds = $derived(new Set(upstream.map((m) => m.id)));
  let upstreamProvider = $state('');
  /** Only rows for the gateway's provider are checked; other providers are not served by it. */
  const notServed = (m: RegisteredModelView): boolean =>
    upstreamLoaded && upstream.length > 0 && m.provider === upstreamProvider && !upstreamIds.has(m.modelId);
  const manualOpen = $derived(upstream.length === 0);

  async function loadUpstream(): Promise<void> {
    upstreamError = null;
    try {
      const r = await api.upstreamModels();
      upstream = r.items;
      upstreamProvider = r.defaultProvider;
      upstreamLoaded = true;
      if (r.unavailable) upstreamError = r.unavailable;
      if (!mf.provider) mf.provider = r.defaultProvider;
    } catch (e) {
      upstream = [];
      upstreamError = (e as Error).message;
    }
  }

  /** Fill id/provider from the upstream model and attach catalog metadata matched by id, if any. */
  function pickUpstream(m: UpstreamModel): void {
    mf.modelId = m.id;
    if (m.catalog) mf.metadata = m.catalog;
    modelFormErr = '';
  }
  let planDialog = $state(false);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      void loadUpstream();
      const [m, p] = await Promise.all([api.platformModels(), api.platformPlans()]);
      models = m.items;
      plans = p.items;
      const perPlan = await Promise.all(p.items.map(async (pl) => [pl.key, await api.planStageModels(pl.key)] as const));
      stagesByPlan = Object.fromEntries(perPlan.map(([k, v]) => [k, v.items]));
      strategies = perPlan[0]?.[1].strategies ?? [];
      stageNames = perPlan[0]?.[1].items.map((i) => i.stage) ?? [];
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
  });

  const forbidden = $derived(loadError !== null && loadError.startsWith('403'));

  /** The registry has no display name; `provider/modelId` is the model's identity. */
  const modelLabel = (m: { provider: string; modelId: string }): string => `${m.provider}/${m.modelId}`;


  let stagesByPlan = $state<Record<string, { stage: string; strategy: string; modelIds: string[] }[]>>({});
  let strategies = $state<string[]>([]);
  /** Stage names in review execution order. */
  let stageNames = $state<string[]>([]);

  const activeModels = $derived(models.filter((m) => m.active));

  // Models this plan actually runs: fill-first uses only the first; round-robin/random use all.
  function runningModels(planKey: string): RegisteredModelView[] {
    const rows = stagesByPlan[planKey] ?? [];
    const src = rows.length > 0 ? rows : stageNames.map((stage) => ({ stage, strategy: 'fill-first', modelIds: [] as string[] }));
    const ids = new Set<string>();
    for (const row of src) {
      // Inactive models are ignored, matching the runtime join.
      const picked = row.modelIds.filter((id) => activeModels.some((m) => m.id === id));
      if (picked.length === 0) {
        // Unconfigured stage falls back to the first registry model (same rule as backend resolveDefaultModel).
        if (activeModels[0]) ids.add(activeModels[0].id);
      } else if (row.strategy === 'fill-first') {
        ids.add(picked[0]);
      } else {
        for (const id of picked) ids.add(id);
      }
    }
    return [...ids].map((id) => activeModels.find((m) => m.id === id)).filter((m) => m !== undefined);
  }



  const blankModel = (): {
    provider: string;
    modelId: string;
    metadata: CatalogEntryView | null;
    sort: number;
    active: boolean;
  } => ({ provider: 'openai', modelId: '', metadata: null, sort: 100, active: true });
  let mf = $state(blankModel());
  /** Row id being edited; null = new. Keyed by id because provider/modelId are editable. */
  let editingModelId = $state<string | null>(null);
  // Separate channels: form errors render in the dialog, list-action results on the page
  // (the dialog may be closed), and in-progress only as button state.
  let modelFormErr = $state('');
  let registryMsg = $state<{ kind: 'error' | 'note'; text: string } | null>(null);
  let modelSaving = $state(false);

  // The catalog is too large to list; search as you type, and show nothing for an empty query.
  let catalogQuery = $state('');
  let catalogHits = $state<CatalogEntryView[]>([]);
  let catalogTotal = $state(0);
  let catalogSearching = $state(false);
  let catalogSyncing = $state(false);
  /** Request sequence number: only the latest response is applied. */
  let catalogSeq = 0;

  async function searchCatalog(term: string): Promise<void> {
    catalogQuery = term;
    const seq = ++catalogSeq;
    if (!term.trim()) {
      catalogHits = [];
      return;
    }
    catalogSearching = true;
    try {
      const r = await api.modelCatalog(term);
      if (seq !== catalogSeq) return; // a newer search superseded this one
      catalogHits = r.items;
      catalogTotal = r.total;
    } catch (e) {
      if (seq === catalogSeq) modelFormErr = (e as Error).message;
    } finally {
      if (seq === catalogSeq) catalogSearching = false;
    }
  }

  async function syncCatalog(): Promise<void> {
    catalogSyncing = true;
    registryMsg = null;
    try {
      const r = await api.syncModelCatalog();
      catalogTotal = r.total;
      // Flag repricing: registry rows may reference these entries and prices drive the cost cap.
      registryMsg = {
        kind: r.repriced.length > 0 ? 'error' : 'note',
        text:
          r.repriced.length > 0
            ? $LL.plans.catalogSyncedRepriced({ total: r.total, models: r.repriced.map((c) => `${c.provider}/${c.modelId}`).join(', ') })
            : $LL.plans.catalogSynced({ total: r.total }),
      };
      if (catalogQuery.trim()) await searchCatalog(catalogQuery);
      await load();
    } catch (e) {
      registryMsg = { kind: 'error', text: (e as Error).message };
    } finally {
      catalogSyncing = false;
    }
  }

  // Three states: picked and found; picked but gone upstream (runtime falls back to the built-in catalog);
  // not picked (uses the built-in entry of the same name, errors if none).
  function metadataCell(m: RegisteredModelView): { text: string; muted: boolean } {
    if (m.metadata) return { text: `${m.metadataRef!.provider}/${m.metadataRef!.modelId}`, muted: false };
    if (m.metadataRef) return { text: $LL.plans.metadataMissing({ ref: `${m.metadataRef.provider}/${m.metadataRef.modelId}` }), muted: true };
    return { text: $LL.plans.metadataBuiltin(), muted: true };
  }

  const catalogSummary = (e: CatalogEntryView): string =>
    `${formatCompact(e.contextWindow, $locale)} ctx · ${formatCompact(e.maxTokens, $locale)} out · $${e.cost.input}/$${e.cost.output} · ${e.input.includes('image') ? 'text+image' : 'text'}${e.reasoning ? ' · reasoning' : ''}`;


  function newModel(): void {
    mf = blankModel();
    editingModelId = null;
    modelFormErr = '';
    modelDialog = true;
    void loadUpstream();
  }

  function editModel(m: RegisteredModelView): void {
    mf = {
      provider: m.provider,
      modelId: m.modelId,
      // A dangling reference leaves `metadata` empty; the dialog shows it as dangling (see metadataLabel).
      metadata: m.metadata && m.metadataRef ? { ...m.metadata, ...m.metadataRef } : null,
      sort: m.sort,
      active: m.active,
    };
    editingModelId = m.id;
    modelFormErr = '';
    catalogQuery = '';
    catalogHits = [];
    modelDialog = true;
    void loadUpstream();
  }

  async function saveModel(): Promise<void> {
    modelSaving = true;
    modelFormErr = '';
    const body = {
      provider: mf.provider.trim(),
      modelId: mf.modelId.trim(),
      // null is meaningful (clear, fall back to the built-in catalog), so always send the field.
      metadata: mf.metadata ? { source: mf.metadata.source, provider: mf.metadata.provider, modelId: mf.metadata.modelId } : null,
      sort: Number(mf.sort) || 100,
      active: mf.active,
    };
    try {
      // Edit by id: submitting by provider/modelId would insert a new row when those change.
      if (editingModelId) await api.updatePlatformModel(editingModelId, body);
      else await api.savePlatformModel(body);
      mf = blankModel();
      editingModelId = null;
      modelDialog = false;
      await load();
    } catch (e) {
      modelFormErr = (e as Error).message;
    } finally {
      modelSaving = false;
    }
  }

  // Reorder persists immediately (one transaction for the whole table); on failure revert to the
  // server order. Arrow keys on the handle reorder too, since HTML5 drag is unusable by keyboard/screen readers.
  let dragId = $state<string | null>(null);

  async function commitOrder(next: RegisteredModelView[]): Promise<void> {
    const before = models;
    models = next;
    registryMsg = null;
    try {
      await api.reorderPlatformModels(next.map((m) => m.id));
      registryMsg = { kind: 'note', text: $LL.plans.reordered() };
      await load();
    } catch (e) {
      models = before;
      registryMsg = { kind: 'error', text: (e as Error).message };
    }
  }

  function moveModel(from: number, to: number): void {
    if (to < 0 || to >= models.length || from === to) return;
    const next = [...models];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    void commitOrder(next);
  }

  function onDrop(targetId: string): void {
    if (!dragId || dragId === targetId) return;
    moveModel(
      models.findIndex((m) => m.id === dragId),
      models.findIndex((m) => m.id === targetId),
    );
    dragId = null;
  }

  function onHandleKeydown(e: KeyboardEvent, i: number): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveModel(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
  }

  // Deleting a model also removes it from stages, which fall back to the first registry model.
  // Deactivate instead to keep the row for historical references.
  async function deleteModel(m: RegisteredModelView): Promise<void> {
    if (!confirm($LL.plans.deleteModelConfirm({ name: modelLabel(m) }))) return;
    registryMsg = null;
    try {
      await api.deletePlatformModel(m.id);
      registryMsg = { kind: 'note', text: $LL.plans.modelDeleted() };
      await load();
    } catch (e) {
      registryMsg = { kind: 'error', text: (e as Error).message };
    }
  }

  async function toggleModelActive(m: RegisteredModelView): Promise<void> {
    registryMsg = null;
    try {
      // Deactivate instead of delete: past reviews still reference the row.
      await api.savePlatformModel({
        provider: m.provider,
        modelId: m.modelId,
        // Send the full row (backend upserts); omitting metadata would clear it.
        metadata: m.metadataRef ?? null,
        sort: m.sort,
        active: !m.active,
      });
      await load();
    } catch (e) {
      registryMsg = { kind: 'error', text: (e as Error).message };
    }
  }

  interface PlanDraft {
    key: string;
    name: string;
    modelTier: string;
    /** Empty = no cost cap (sent as null); 0 would mean immediately over the cap. */
    costCap: string;
    reviewQuota: string;
    tokenQuota: string;
    maxConcurrency: number;
    active: boolean;
  }

  let editingKey = $state<string | null>(null);
  let pf = $state<PlanDraft>(blankPlan());
  let planFormErr = $state('');
  let plansMsg = $state<{ kind: 'error' | 'note'; text: string } | null>(null);
  let planSaving = $state(false);
  // Stage edits are a draft submitted on Save together with the plan, so Cancel really discards them.
  let pfStages = $state<{ stage: string; strategy: string; modelIds: string[] }[]>([]);
  let planTab = $state<'basics' | 'stages'>('basics');

  /** Strip the provider prefix when every registry model shares one; used by stage chips and the plan table. */
  const shortModelLabel = $derived.by(() => {
    const multiProvider = new Set(activeModels.map((m) => m.provider)).size > 1;
    return (m: RegisteredModelView): string => (multiProvider ? `${m.provider}/${m.modelId}` : m.modelId);
  });

  const unpickedFor = (stage: string): RegisteredModelView[] => {
    const ids = pfStages.find((r) => r.stage === stage)?.modelIds ?? [];
    return activeModels.filter((m) => !ids.includes(m.id));
  };

  function addStageModel(stage: string, id: string, at?: number): void {
    pfStages = pfStages.map((r) => {
      if (r.stage !== stage || r.modelIds.includes(id)) return r;
      const i = at ?? r.modelIds.length;
      return { ...r, modelIds: [...r.modelIds.slice(0, i), id, ...r.modelIds.slice(i)] };
    });
  }

  function removeStageModel(stage: string, id: string): void {
    pfStages = pfStages.map((r) => (r.stage === stage ? { ...r, modelIds: r.modelIds.filter((x) => x !== id) } : r));
  }

  // Order matters (fill-first uses the first; round-robin starts there). Dragging within a stage reorders,
  // onto another stage adds it there. Arrow keys reorder too, since HTML5 drag is unusable by keyboard.
  let dragFrom = $state<{ stage: string; id: string } | null>(null);
  let dragOverStage = $state<string | null>(null);

  function moveStageModel(stage: string, from: number, to: number): void {
    pfStages = pfStages.map((r) => {
      if (r.stage !== stage) return r;
      if (to < 0 || to >= r.modelIds.length || from === to) return r;
      const next = [...r.modelIds];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...r, modelIds: next };
    });
  }

  /** `targetId` = chip dropped on; undefined appends to the end. */
  function dropOnStage(stage: string, targetId?: string): void {
    const from = dragFrom;
    dragFrom = null;
    dragOverStage = null;
    if (!from) return;
    const ids = pfStages.find((r) => r.stage === stage)?.modelIds ?? [];
    if (from.stage === stage) {
      if (targetId && targetId !== from.id) moveStageModel(stage, ids.indexOf(from.id), ids.indexOf(targetId));
      return;
    }
    addStageModel(stage, from.id, targetId ? ids.indexOf(targetId) : undefined);
  }

  function onChipKeydown(e: KeyboardEvent, stage: string, id: string): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const ids = pfStages.find((r) => r.stage === stage)?.modelIds ?? [];
    const i = ids.indexOf(id);
    moveStageModel(stage, i, e.key === 'ArrowLeft' ? i - 1 : i + 1);
  }

  function setDraftStrategy(stage: string, strategy: string): void {
    pfStages = pfStages.map((r) => (r.stage === stage ? { ...r, strategy } : r));
  }

  // An unconfigured stage defaults to the full registry, fill-first: the same thing the backend runs.
  function draftStages(planKey: string | null): { stage: string; strategy: string; modelIds: string[] }[] {
    const rows = planKey === null ? [] : (stagesByPlan[planKey] ?? []);
    return stageNames.map((stage) => {
      const stored = rows.find((r) => r.stage === stage);
      const picked = (stored?.modelIds ?? []).filter((id) => activeModels.some((m) => m.id === id));
      return {
        stage,
        strategy: stored?.strategy ?? 'fill-first',
        modelIds: picked.length > 0 ? picked : activeModels.map((m) => m.id),
      };
    });
  }

  function blankPlan(): PlanDraft {
    return { key: '', name: '', modelTier: 'balanced', costCap: '', reviewQuota: '', tokenQuota: '', maxConcurrency: 2, active: true };
  }

  function editPlan(p: PlatformPlanView): void {
    planDialog = true;
    editingKey = p.key;
    pf = {
      key: p.key,
      name: p.name,
      modelTier: p.modelTier,
      costCap: p.monthlyCostCapUsd === null ? '' : String(p.monthlyCostCapUsd),
      reviewQuota: p.monthlyReviewQuota === null ? '' : String(p.monthlyReviewQuota),
      tokenQuota: p.monthlyTokenQuota === null ? '' : String(p.monthlyTokenQuota),
      maxConcurrency: p.maxConcurrency,
      active: p.active,
    };
    pfStages = draftStages(p.key);
    planTab = 'basics';
    planFormErr = '';
  }

  function newPlan(): void {
    editingKey = null;
    pf = blankPlan();
    pfStages = draftStages(null);
    planTab = 'basics';
    planFormErr = '';
  }

  function openNewPlan(): void {
    newPlan();
    planDialog = true;
  }

  /** Empty string = no cap (null). */
  function numOrNull(v: string): number | null {
    const t = v.trim();
    return t === '' ? null : Number(t);
  }

  // Both endpoints replace the whole document, so retrying after a partial failure is safe.
  async function savePlan(): Promise<void> {
    planSaving = true;
    planFormErr = '';
    const key = pf.key.trim();
    try {
      await api.savePlatformPlan(key, {
        name: pf.name.trim(),
        modelTier: pf.modelTier,
        monthlyCostCapUsd: numOrNull(pf.costCap),
        monthlyReviewQuota: numOrNull(pf.reviewQuota),
        monthlyTokenQuota: numOrNull(pf.tokenQuota),
        maxConcurrency: Number(pf.maxConcurrency) || 1,
        active: pf.active,
      });
      for (const row of pfStages) {
        await api.savePlanStageModels(key, row.stage, { modelIds: row.modelIds, strategy: row.strategy });
      }
      newPlan();
      planDialog = false;
      await load();
    } catch (e) {
      planFormErr = (e as Error).message;
    } finally {
      planSaving = false;
    }
  }

  /** Deactivated plans are not assigned to new tenants. Send the full row: the backend upserts by key. */
  async function togglePlanActive(p: PlatformPlanView): Promise<void> {
    plansMsg = null;
    try {
      await api.savePlatformPlan(p.key, {
        name: p.name,
        modelTier: p.modelTier,
        monthlyCostCapUsd: p.monthlyCostCapUsd,
        monthlyReviewQuota: p.monthlyReviewQuota,
        monthlyTokenQuota: p.monthlyTokenQuota,
        maxConcurrency: p.maxConcurrency,
        active: !p.active,
      });
      await load();
    } catch (e) {
      plansMsg = { kind: 'error', text: (e as Error).message };
    }
  }

  function planSummary(p: PlatformPlanView): string {
    const parts = [
      p.monthlyCostCapUsd === null ? $LL.plans.noCostCap() : `${$LL.quota.cost()} ${fmtUsd(p.monthlyCostCapUsd)}`,
      `${$LL.plans.concurrency()} ${p.maxConcurrency}`,
    ];
    if (p.monthlyReviewQuota !== null) parts.push(`${$LL.plans.abuseReviews()} ${formatCompact(p.monthlyReviewQuota, $locale)}`);
    // Compact notation; the exact value is in the title.
    if (p.monthlyTokenQuota !== null) parts.push(`${$LL.plans.abuseTokens()} ${formatCompact(p.monthlyTokenQuota, $locale)}`);
    return parts.join(' · ');
  }

  function planSummaryExact(p: PlatformPlanView): string {
    const parts: string[] = [];
    if (p.monthlyReviewQuota !== null) parts.push(`${$LL.plans.abuseReviews()} ${formatNumber(p.monthlyReviewQuota, $locale)}`);
    if (p.monthlyTokenQuota !== null) parts.push(`${$LL.plans.abuseTokens()} ${formatNumber(p.monthlyTokenQuota, $locale)}`);
    return parts.join(' · ');
  }

</script>

{#snippet resultBar(msg: { kind: 'error' | 'note'; text: string } | null)}
  {#if msg?.kind === 'error'}
    <ErrorText message={msg.text} />
  {:else if msg}
    <p class="text-muted-foreground mt-0 mb-3 text-sm">{msg.text}</p>
  {/if}
{/snippet}

<PageHeader title={$LL.page.plans()} />

{#if $me && !$me.isOperator}<Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>{/if}

{#if loading && plans.length === 0 && models.length === 0}
  <Loading />
{:else if forbidden}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{:else if loadError}
  <ErrorText message={loadError} />
{:else}
  <Section title={$LL.plans.registryTitle()} flush>
    {#snippet actions()}
      <Button variant="ghost" size="sm" disabled={catalogSyncing} onclick={syncCatalog}>
        {catalogSyncing ? $LL.plans.catalogSyncing() : $LL.plans.catalogSync()}
      </Button>
      <Button size="icon-sm" aria-label={$LL.plans.modelFormTitle()} title={$LL.plans.modelFormTitle()} onclick={newModel}>
        <Plus aria-hidden="true" />
      </Button>
    {/snippet}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-10"><span class="sr-only">{$LL.plans.reorder()}</span></Table.Head>
          <Table.Head class="w-16">{$LL.col.status()}</Table.Head>
          <Table.Head>{$LL.col.provider()}</Table.Head>
          <Table.Head>{$LL.plans.colModelId()}</Table.Head>
          <Table.Head>{$LL.plans.colMetadata()}</Table.Head>
          <Table.Head></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each models as m, i (m.id)}
          <Table.Row
            class={[!m.active && 'inactive', dragId === m.id && 'dragging']}
            ondragover={(e) => e.preventDefault()}
            ondrop={(e) => { e.preventDefault(); onDrop(m.id); }}
          >
            <Table.Cell>
              <span
                class="drag-handle"
                draggable="true"
                role="button"
                tabindex="0"
                aria-label="{$LL.plans.reorder()}:{modelLabel(m)}"
                ondragstart={() => (dragId = m.id)}
                ondragend={() => (dragId = null)}
                onkeydown={(e) => onHandleKeydown(e, i)}
              >
                <GripVertical class="size-4" aria-hidden="true" />
              </span>
            </Table.Cell>
            <Table.Cell>
              <Checkbox
                checked={m.active}
                aria-label="{$LL.common.toggleActive()}:{modelLabel(m)}"
                onCheckedChange={() => toggleModelActive(m)}
              />
            </Table.Cell>

            <Table.Cell>{m.provider}</Table.Cell>
            <Table.Cell>
              <code>{m.modelId}</code>
              {#if notServed(m)}
                <div class="text-muted-foreground text-xs">{$LL.plans.upstreamMissing()}</div>
              {/if}
            </Table.Cell>
            {@const md = metadataCell(m)}
            <Table.Cell class={md.muted ? 'text-muted-foreground text-sm' : undefined}>{md.text}</Table.Cell>
            <Table.Cell class="row-actions">
              <Button variant="ghost" size="sm" onclick={() => editModel(m)}>{$LL.common.edit()}</Button>
              <Button variant="ghost" size="sm" class="text-muted-foreground" onclick={() => deleteModel(m)}>
                {$LL.plans.deleteModel()}
              </Button>
            </Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row><Table.Cell colspan={8}><EmptyState title={$LL.plans.noModels()} /></Table.Cell></Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {@render resultBar(registryMsg)}
  </Section>

  <Section title={$LL.plans.plansTitle()} flush>
    {#snippet actions()}
      <Button size="icon-sm" aria-label={$LL.plans.newPlanTitle()} title={$LL.plans.newPlanTitle()} onclick={openNewPlan}>
        <Plus aria-hidden="true" />
      </Button>
    {/snippet}
    <Table.Root class="table-fixed">
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-14">{$LL.col.status()}</Table.Head>
          <Table.Head class="w-40">{$LL.plans.colKey()}</Table.Head>
          <Table.Head>{$LL.plans.colLimits()}</Table.Head>
          <Table.Head class="w-64">{$LL.plans.colRunningModels()}</Table.Head>
          <Table.Head class="w-24"></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each plans as p (p.id)}
          <Table.Row class={p.active ? undefined : 'inactive'}>
            <Table.Cell>
              <Checkbox
                checked={p.active}
                aria-label="{$LL.common.toggleActive()}:{p.key}"
                onCheckedChange={() => togglePlanActive(p)}
              />
            </Table.Cell>
            <Table.Cell class="truncate" title={p.name}><code>{p.key}</code></Table.Cell>
            <Table.Cell class="text-muted-foreground text-sm whitespace-normal" title={planSummaryExact(p)}>
              {planSummary(p)}
            </Table.Cell>
            <!-- Only models actually run (per stage algorithm, deduplicated) -->
            <Table.Cell class="whitespace-normal">
              {#each runningModels(p.key) as m (m.id)}
                <code class="model-pill">{shortModelLabel(m)}</code>
              {:else}
                <!-- Empty registry: the platform falls back to env/tier deployment -->
                <span class="text-muted-foreground text-sm">{$LL.plans.emptySetFallback()}</span>
              {/each}
            </Table.Cell>
            <Table.Cell class="row-actions">
              <Button variant="ghost" size="sm" onclick={() => editPlan(p)}>{$LL.common.edit()}</Button>
            </Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row><Table.Cell colspan={5}><EmptyState title={$LL.plans.noPlans()} /></Table.Cell></Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {@render resultBar(plansMsg)}
  </Section>
{/if}

<Dialog.Root bind:open={modelDialog}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{editingModelId ? $LL.plans.editModelTitle() : $LL.plans.modelFormTitle()}</Dialog.Title>
    </Dialog.Header>
    {#if upstream.length > 0}
      <FormField label={$LL.plans.upstreamPick()}>
        <ul class="upstream-list">
          {#each upstream as m (m.id)}
            <li>
              <button
                type="button"
                class="upstream-item"
                class:on={mf.modelId === m.id}
                onclick={() => pickUpstream(m)}
              >
                <code>{m.id}</code>
                {#if m.ownedBy}<span class="text-muted-foreground text-xs">{m.ownedBy}</span>{/if}
                <span class="flex-1"></span>
                {#if m.registered}<span class="text-muted-foreground text-xs">{$LL.plans.upstreamRegistered()}</span>{/if}
                {#if !m.catalog}<span class="text-muted-foreground text-xs">{$LL.plans.upstreamNoSpecs()}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </FormField>
    {:else if upstreamError}
      <p class="text-muted-foreground mt-0 mb-0 text-sm">{$LL.plans.upstreamUnavailable({ reason: upstreamError })}</p>
    {/if}

    <details class="manual-model" open={manualOpen}>
      <summary>{$LL.plans.manualEntry()}</summary>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField label={$LL.col.provider()}><Input bind:value={mf.provider} placeholder="openai" /></FormField>
        <FormField label={$LL.plans.colModelId()}><Input bind:value={mf.modelId} placeholder="gpt-4o-mini" /></FormField>
      </div>
    </details>
    <div class="grid gap-4 sm:grid-cols-2">
      <FormField label={$LL.plans.colSort()}><Input type="number" bind:value={mf.sort} /></FormField>
    </div>

    <FormField label={$LL.plans.colMetadata()}>
      {#if mf.metadata}
        <div class="picked-meta">
          <div>
            <code>{mf.metadata.provider}/{mf.metadata.modelId}</code>
            <p class="text-muted-foreground mt-0.5 mb-0 text-xs">{catalogSummary(mf.metadata)}</p>
          </div>
          <Button variant="ghost" size="sm" onclick={() => (mf.metadata = null)}>{$LL.plans.metadataClear()}</Button>
        </div>
      {/if}
      <Input
        value={catalogQuery}
        placeholder={catalogTotal > 0 ? $LL.plans.metadataSearch({ total: catalogTotal }) : $LL.plans.metadataEmptyCatalog()}
        oninput={(e) => void searchCatalog((e.currentTarget as HTMLInputElement).value)}
      />
      {#if catalogSearching}
        <p class="text-muted-foreground mt-2 mb-0 text-xs">{$LL.common.loading()}</p>
      {:else if catalogQuery.trim() && catalogHits.length === 0}
        <p class="text-muted-foreground mt-2 mb-0 text-xs">{$LL.plans.metadataNoHits()}</p>
      {:else if catalogHits.length > 0}
        <ul class="catalog-hits">
          {#each catalogHits as e (`${e.source}/${e.provider}/${e.modelId}`)}
            <li>
              <button type="button" onclick={() => { mf.metadata = e; catalogQuery = ''; catalogHits = []; }}>
                <code>{e.provider}/{e.modelId}</code>
                <span class="text-muted-foreground text-xs">{catalogSummary(e)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </FormField>
    <label class="chk"><Checkbox bind:checked={mf.active} />{$LL.plans.active()}</label>
    <!-- Endpoint and key are server-side config only -->
    {#if modelFormErr}<ErrorText message={modelFormErr} />{/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (modelDialog = false)}>{$LL.common.cancel()}</Button>
      <Button onclick={saveModel} disabled={modelSaving || !mf.provider.trim() || !mf.modelId.trim()}>
        {modelSaving ? $LL.common.saving() : $LL.common.save()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={planDialog}>
  <Dialog.Content class="sm:max-w-4xl">
    <Dialog.Header>
      <Dialog.Title>{editingKey ? $LL.plans.editPlanTitle() : $LL.plans.newPlanTitle()}</Dialog.Title>
    </Dialog.Header>
    <Tabs.Root bind:value={planTab}>
      <Tabs.List>
        <Tabs.Trigger value="basics">{$LL.plans.tabBasics()}</Tabs.Trigger>
        <Tabs.Trigger value="stages">{$LL.plans.stageTitle()}</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="basics">
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField label={$LL.plans.colKey()}>
            <Input bind:value={pf.key} disabled={editingKey !== null} placeholder="starter" />
          </FormField>
          <FormField label={$LL.plans.colDisplayName()}><Input bind:value={pf.name} placeholder="Starter" /></FormField>
          <FormField label="{$LL.quota.cost()} (USD)">
            <Input bind:value={pf.costCap} placeholder={$LL.plans.unlimitedPlaceholder()} />
          </FormField>
          <FormField label={$LL.plans.abuseReviews()}>
            <Input bind:value={pf.reviewQuota} placeholder={$LL.plans.unlimitedPlaceholder()} />
          </FormField>
          <FormField label={$LL.plans.abuseTokens()}>
            <Input bind:value={pf.tokenQuota} placeholder={$LL.plans.unlimitedPlaceholder()} />
          </FormField>
          <FormField label={$LL.plans.concurrency()}><Input type="number" bind:value={pf.maxConcurrency} /></FormField>
          <FormField label={$LL.plans.fallbackTier()}>
            <SelectField
              options={[{ value: 'quality', label: 'quality' }, { value: 'balanced', label: 'balanced' }, { value: 'cheap', label: 'cheap' }]}
              bind:value={pf.modelTier}
            />
          </FormField>
        </div>
        <label class="chk mt-4"><Checkbox bind:checked={pf.active} />{$LL.plans.active()}</label>
      </Tabs.Content>

      <Tabs.Content value="stages">
        {#if activeModels.length === 0}
          <p class="text-muted-foreground mt-0 mb-0 text-sm">{$LL.plans.noModels()}</p>
        {:else}
          <div class="stage-list">
            {#each pfStages as row (row.stage)}
              {@const picked = row.modelIds.map((id) => activeModels.find((m) => m.id === id)).filter((m) => m !== undefined)}
              {@const rest = unpickedFor(row.stage)}
              <!-- Check relatedTarget on dragleave: entering a child chip also fires it on the parent -->
              <div
                class="stage-item"
                class:over={dragOverStage === row.stage}
                role="group"
                aria-label={row.stage}
                ondragover={(e) => { e.preventDefault(); dragOverStage = row.stage; }}
                ondragleave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dragOverStage = null; }}
                ondrop={(e) => { e.preventDefault(); dropOnStage(row.stage); }}
              >
                <div class="stage-name">
                  <code>{row.stage}</code>
                  {#if picked.length > 1}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger class="stage-strategy">
                        {row.strategy}
                        <ChevronDown class="size-3 opacity-60" aria-hidden="true" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content class="w-40" align="start">
                        {#each strategies as v (v)}
                          <DropdownMenu.Item onSelect={() => setDraftStrategy(row.stage, v)}>
                            <span class="flex-1">{v}</span>
                            {#if v === row.strategy}<Check class="size-4" />{/if}
                          </DropdownMenu.Item>
                        {/each}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  {/if}
                </div>
                <div class="choice-wrap">
                  {#each picked as m, i (m.id)}
                    <button
                      type="button"
                      class="choice-chip on"
                      draggable="true"
                      title={$LL.plans.stageChipHint()}
                      ondragstart={() => (dragFrom = { stage: row.stage, id: m.id })}
                      ondragend={() => { dragFrom = null; dragOverStage = null; }}
                      ondragover={(e) => e.preventDefault()}
                      ondrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnStage(row.stage, m.id); }}
                      onkeydown={(e) => onChipKeydown(e, row.stage, m.id)}
                      onclick={() => removeStageModel(row.stage, m.id)}
                    >
                      {#if picked.length > 1}<span class="choice-ord">{i + 1}</span>{/if}
                      {shortModelLabel(m)}
                    </button>
                  {/each}
                  {#if picked.length === 0}
                    <!-- An empty stage falls back to the first registry model -->
                    <span class="text-muted-foreground text-xs">
                      {$LL.plans.stageEmpty({ model: shortModelLabel(activeModels[0]) })}
                    </span>
                  {/if}
                  {#if rest.length > 0}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger class="stage-add" aria-label="{$LL.plans.stageAdd()}:{row.stage}" title={$LL.plans.stageAdd()}>
                        <Plus class="size-3.5" aria-hidden="true" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content class="w-56" align="start">
                        {#each rest as m (m.id)}
                          <DropdownMenu.Item onSelect={() => addStageModel(row.stage, m.id)}>{modelLabel(m)}</DropdownMenu.Item>
                        {/each}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Tabs.Content>
    </Tabs.Root>
    {#if planFormErr}<ErrorText message={planFormErr} />{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (planDialog = false)}>{$LL.common.cancel()}</Button>
      <Button onclick={savePlan} disabled={planSaving || !pf.key.trim() || !pf.name.trim()}>
        {planSaving ? $LL.common.saving() : $LL.common.save()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
