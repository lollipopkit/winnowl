<script lang="ts">
  /**
   * BYOK (bring your own LLM key); its tokens and cost do not count against the platform quota (see `periodUsage`).
   * Scopes: organisation / repository (admin) and "only me" (reviews the user started). The key is write-only.
   * The backend validates key and model on save, so errors surface here instead of as a silent fallback to the platform key.
   */
  import { api, ApiError, type ByokInput, type ByokMeta, type ByokModelOption, type Repository } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatEventTime } from '$lib/format';
  import Section from './Section.svelte';
  import FormField from './FormField.svelte';
  import SelectField from './SelectField.svelte';
  import ErrorText from './ErrorText.svelte';
  import Badge from './Badge.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  /** Organisation and repository scopes are the tenant's (admin); "only me" is everyone's. */
  let { canManage }: { canManage: boolean } = $props();

  const ME = 'me';
  const ORG = '';

  let repos = $state<Repository[]>([]);
  let ownRepos = $state<string[]>([]);
  /** null until known; false in deployments without user accounts (the endpoint refuses). */
  let mineAvailable = $state<boolean | null>(null);
  let scope = $state<string>(ORG);
  let meta = $state<ByokMeta | null>(null);
  let inherited = $state<ByokMeta | null>(null);
  let providers = $state<string[]>(['openai', 'anthropic', 'openrouter', 'deepseek']);

  let provider = $state('openai');
  let model = $state('');
  let modelQuality = $state('');
  let modelCheap = $state('');
  let templateModel = $state('');
  let apiKey = $state('');
  /** The model list belongs to the provider it was asked from. */
  let listed = $state<{ provider: string; models: ByokModelOption[] } | null>(null);

  let busy = $state(false);
  let error = $state('');
  let errorReason = $state('');
  let saved = $state(false);

  const scopeOptions = $derived([
    ...(mineAvailable ? [{ value: ME, label: String($LL.plugins.scopeMine()) }] : []),
    ...(canManage
      ? [
          { value: ORG, label: String($LL.plugins.orgWide()) },
          ...repos.map((r) => ({
            value: String(r.id),
            label: `${r.namespace}/${r.name}${ownRepos.includes(String(r.id)) ? ` · ${$LL.plugins.byokOwnKey()}` : ''}`,
          })),
        ]
      : []),
  ]);
  const visible = $derived(canManage || mineAvailable === true);

  // Keep the form on a scope it can save to (roles and "only me" arrive asynchronously).
  $effect(() => {
    if (scopeOptions.length > 0 && !scopeOptions.some((o) => o.value === scope)) scope = scopeOptions[0]!.value;
  });

  /** The stored key can stand in for a new one while the provider stays the same. */
  const keyKept = $derived(meta !== null && meta.provider === provider);
  const models = $derived(listed?.provider === provider ? listed.models : null);
  const chosen = $derived([model, modelQuality, modelCheap].map((m) => m.trim()).filter(Boolean));
  /** A template is needed for a chosen model the platform has no specification of. */
  const needsTemplate = $derived(
    !!templateModel || errorReason === 'model_spec_unknown' || (models !== null && chosen.some((id) => models.find((m) => m.id === id)?.known === false)),
  );

  const fieldLabel = (field: string | undefined): string => {
    switch (field) {
      case 'model':
        return $LL.plugins.byokModel();
      case 'modelQuality':
        return $LL.plugins.byokModelQuality();
      case 'modelCheap':
        return $LL.plugins.byokModelCheap();
      case 'templateModel':
        return $LL.plugins.byokTemplateModel();
      case 'apiKey':
        return $LL.plugins.apiKey();
      case 'provider':
        return $LL.col.provider();
      default:
        return field ?? '';
    }
  };

  /** A refusal the API explained, in the reader's language; anything else as it came. */
  function describe(e: unknown): string {
    const reason = e instanceof ApiError ? e.code.reason : undefined;
    const known = $LL.plugins.byokErrors as unknown as Record<string, ((p: { field: string }) => string) | undefined>;
    if (e instanceof ApiError && reason && known[reason]) return known[reason]!({ field: fieldLabel(e.code.field) });
    return (e as Error).message;
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = '';
    errorReason = '';
    saved = false;
    try {
      await fn();
    } catch (e) {
      error = describe(e);
      errorReason = e instanceof ApiError ? (e.code.reason ?? '') : '';
    } finally {
      busy = false;
    }
  }

  function fill(m: ByokMeta | null): void {
    provider = m?.provider ?? 'openai';
    model = m?.model ?? '';
    modelQuality = m?.modelQuality ?? '';
    modelCheap = m?.modelCheap ?? '';
    templateModel = m?.templateModel ?? '';
    apiKey = '';
  }

  async function load(): Promise<void> {
    error = '';
    errorReason = '';
    saved = false;
    listed = null;
    try {
      const view = scope === ME ? await api.myByok() : await api.byok(scope || undefined);
      meta = view.byok;
      inherited = view.inherited ?? null;
      if (view.providers?.length) providers = view.providers;
      if (scope === ORG) ownRepos = view.repositories ?? [];
    } catch {
      meta = null;
      inherited = null;
    }
    fill(meta);
    // With a stored key the list needs nothing typed.
    if (meta) await listModels();
  }

  async function listModels(): Promise<void> {
    await run(async () => {
      const body = { provider, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      const r = scope === ME ? await api.myByokModels(body) : await api.byokModels({ ...body, ...(scope ? { repositoryId: scope } : {}) });
      listed = { provider: body.provider, models: r.models };
    });
  }

  async function save(): Promise<void> {
    await run(async () => {
      const body: ByokInput = {
        provider,
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(modelQuality.trim() ? { modelQuality: modelQuality.trim() } : {}),
        ...(modelCheap.trim() ? { modelCheap: modelCheap.trim() } : {}),
        ...(templateModel.trim() ? { templateModel: templateModel.trim() } : {}),
      };
      if (scope === ME) await api.saveMyByok(body);
      else await api.saveByok({ ...body, ...(scope ? { repositoryId: scope } : {}) });
      await load();
      saved = true;
    });
  }

  async function remove(): Promise<void> {
    await run(async () => {
      if (scope === ME) await api.deleteMyByok();
      else await api.deleteByok(scope ? { repositoryId: scope } : {});
      await load();
    });
  }

  $effect(() => {
    void api.myByok().then(() => (mineAvailable = true)).catch(() => (mineAvailable = false));
  });
  $effect(() => {
    if (canManage) void api.repositories({ limit: 200 }).then((r) => (repos = r.items)).catch(() => undefined);
  });
  $effect(() => {
    void scope;
    if (visible) void load();
  });

  const when = (iso: string): string => formatEventTime(iso, $locale);
</script>

{#if visible}
  <!-- Title not localized: BYOK is a term. -->
  <Section title="BYOK">
    {#snippet actions()}
      <Badge
        value={meta ? $LL.plugins.byokConfigured({ provider: meta.provider, model: meta.model }) : $LL.plugins.byokNotConfigured()}
        tone={meta ? 'accent' : 'neutral'}
      />
      {#if meta}
        <Button variant="ghost" size="sm" disabled={busy} onclick={remove}>{$LL.plugins.remove()}</Button>
      {/if}
    {/snippet}

    {#if error}<ErrorText message={error} />{/if}

    <div class="max-w-sm">
      <FormField label={$LL.plugins.repository()} hint={scope === ME ? $LL.plugins.byokScopeMineHint() : undefined}>
        <SelectField options={scopeOptions} bind:value={scope} />
      </FormField>
    </div>

    <div class="byok-status">
      {#if !meta && inherited}
        <p>{$LL.plugins.byokInherited({ provider: inherited.provider, model: inherited.model })}</p>
      {/if}
      {#if meta}
        <p>{meta.lastUsedAt ? $LL.plugins.byokLastUsed({ time: when(meta.lastUsedAt) }) : $LL.plugins.byokNeverUsed()}</p>
      {/if}
    </div>
    {#if meta?.lastError && meta.lastErrorAt}
      <Alert.Root variant="destructive" class="mt-3">
        <CircleAlert />
        <Alert.Description>
          {$LL.plugins.byokFallback({ time: when(meta.lastErrorAt), reason: $LL.plugins.byokFallbackReasons[meta.lastError]() })}
        </Alert.Description>
      </Alert.Root>
    {/if}

    <div class="border-border mt-5 grid gap-4 border-t pt-5 sm:grid-cols-2 lg:grid-cols-3">
      <FormField label={$LL.col.provider()}>
        <SelectField options={providers.map((p) => ({ value: p, label: p }))} bind:value={provider} />
      </FormField>
      <FormField label={$LL.plugins.apiKey()} hint={keyKept ? $LL.plugins.byokKeyKept() : undefined}>
        <Input type="password" bind:value={apiKey} autocomplete="off" />
      </FormField>
      <FormField label={$LL.plugins.byokModel()} hint={models ? $LL.plugins.byokModelsAvailable({ count: models.length }) : undefined}>
        <Input type="text" list="byok-models" bind:value={model} autocomplete="off" />
      </FormField>
      <FormField label={$LL.plugins.byokModelQuality()}>
        <Input type="text" list="byok-models" bind:value={modelQuality} autocomplete="off" />
      </FormField>
      <FormField label={$LL.plugins.byokModelCheap()}>
        <Input type="text" list="byok-models" bind:value={modelCheap} autocomplete="off" />
      </FormField>
      {#if needsTemplate}
        <FormField label={$LL.plugins.byokTemplateModel()} hint={$LL.plugins.byokTemplateHint()}>
          <Input type="text" list="byok-template-models" bind:value={templateModel} autocomplete="off" />
        </FormField>
      {/if}
    </div>
    {#if models}
      <datalist id="byok-models">
        {#each models as m (m.id)}<option value={m.id}>{m.known ? '' : $LL.plugins.byokNoSpec()}</option>{/each}
      </datalist>
      <datalist id="byok-template-models">
        {#each models.filter((m) => m.known) as m (m.id)}<option value={m.id}></option>{/each}
      </datalist>
    {/if}

    <div class="save-bar border-border mt-5 flex flex-wrap items-center gap-2 border-t pt-5">
      <Button variant="outline" disabled={busy || (!apiKey.trim() && !keyKept)} onclick={listModels}>{$LL.plugins.byokListModels()}</Button>
      <Button disabled={busy || !model.trim() || (!apiKey.trim() && !keyKept)} onclick={save}>{$LL.plugins.setKey()}</Button>
      {#if saved}<span class="text-muted-foreground text-sm">{$LL.common.saved()}</span>{/if}
    </div>
  </Section>
{/if}

