<script lang="ts">
  import { api, type PluginInfo, type Repository, type ServiceCredentialMeta } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { toast } from 'svelte-sonner';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';

  import * as Table from '$lib/components/ui/table/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import Section from '$lib/components/Section.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { me, roleAtLeast } from '$lib/me';
  // Credential keys are write-only and never echoed back.
  let loaded = $state(false);
  let error = $state('');

  let plugins = $state<PluginInfo[]>([]);
  let toggles = $state<Record<string, boolean>>({});
  // Server-side copy of the toggles, used to detect unsaved changes.
  let savedToggles = $state<Record<string, boolean>>({});
  const togglesDirty = $derived(plugins.some((p) => (toggles[p.name] ?? true) !== (savedToggles[p.name] ?? true)));
  let creds = $state<ServiceCredentialMeta[]>([]);
  /** null = user scope unavailable (claims-only auth, endpoint returns 400). */
  let myCreds = $state<ServiceCredentialMeta[] | null>(null);
  let repos = $state<Repository[]>([]);

  let credService = $state('');
  /** org/repo scopes need admin; anyone may add user-scoped credentials. */
  let credScope = $state<'org' | 'repo' | 'user'>('org');
  let credRepositoryId = $state('');
  let credKey = $state('');

  const isAdmin = $derived(roleAtLeast($me?.role, 'admin'));
  // Show only the caller's own user-scope entries: the endpoint returns every user's metadata in the tenant.
  const allCreds = $derived([...creds.filter((c) => c.scope !== 'user'), ...(myCreds ?? [])]);

  const scopeOptions = $derived([
    ...(isAdmin
      ? [
          { value: 'org', label: String($LL.plugins.orgWide()) },
          { value: 'repo', label: String($LL.plugins.repository()) },
        ]
      : []),
    ...(myCreds !== null ? [{ value: 'user', label: String($LL.plugins.scopeMine()) }] : []),
  ]);

  // Keep the form on a submittable scope. An effect because `$me` and `myCreds` arrive independently;
  // skip while empty so an admin's default isn't changed before `$me` loads.
  $effect(() => {
    if (scopeOptions.length > 0 && !scopeOptions.some((o) => o.value === credScope)) {
      credScope = scopeOptions[0].value as typeof credScope;
    }
  });

  const scopeLabel = (c: ServiceCredentialMeta): string => {
    if (c.scope === 'user') return $LL.plugins.scopeMine();
    if (c.scope !== 'repo') return $LL.plugins.orgWide();
    const r = repos.find((x) => x.id === c.repositoryId);
    return r ? `${r.namespace}/${r.name}` : (c.repositoryId ?? '');
  };

  async function load(): Promise<void> {
    error = '';
    try {
      const [reg, ts, sc, rp] = await Promise.all([
        api.plugins(),
        api.tenantSettings(),
        api.serviceCredentials(),
        api.repositories({ limit: 200 }),
      ]);
      plugins = reg.plugins;
      toggles = Object.fromEntries(plugins.map((p) => [p.name, ts.settings.plugins?.[p.name]?.enabled ?? true]));
      savedToggles = { ...toggles };
      creds = sc.credentials;
      repos = rp.items;
      credService = credService || (plugins[0]?.name ?? '');
      try {
        myCreds = (await api.myServiceCredentials()).credentials;
      } catch {
        myCreds = null; // claims mode has no userId, so user scope is unavailable
      }
    } catch (e) {
      error = (e as Error).message;
    }
    loaded = true;
  }
  void load();

  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      toast.success($LL.common.saved());
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const saveToggles = (): Promise<void> =>
    run(() => api.saveTenantSettings(Object.fromEntries(plugins.map((p) => [p.name, { enabled: toggles[p.name] ?? true }]))));

  // Errors propagate to AddDialog. User scope needs review:read; org/repo scopes need installation:manage.
  async function saveCredential(): Promise<void> {
    if (credScope === 'user') {
      await api.saveMyServiceCredential({ service: credService, apiKey: credKey });
    } else {
      await api.saveServiceCredential({
        service: credService,
        apiKey: credKey,
        ...(credScope === 'repo' ? { repositoryId: credRepositoryId } : {}),
      });
    }
    credKey = '';
    toast.success($LL.common.saved());
    await load();
  }

  const removeCredential = (c: ServiceCredentialMeta): Promise<void> =>
    run(() =>
      c.scope === 'user'
        ? api.deleteMyServiceCredential(c.service)
        : api.deleteServiceCredential({ service: c.service, ...(c.repositoryId ? { repositoryId: c.repositoryId } : {}) }),
    );

  const registryColumns = $derived<Column[]>([
    { key: 'service', label: $LL.plugins.service() },
    { key: 'publisher', label: $LL.plugins.publisher() },
    { key: 'enabled', label: $LL.plugins.enabled() },
  ]);

  const credColumns = $derived<Column[]>([
    { key: 'service', label: $LL.plugins.service() },
    { key: 'scope', label: $LL.col.scope() },
    { key: 'updated', label: $LL.plugins.updated() },
    { key: 'actions', label: '' },
  ]);
</script>

{#if error}<ErrorText message={error} />{/if}
{#if loaded}

  <!-- Save is disabled when nothing changed, so its state shows whether there are unsaved edits -->
  <Section title={$LL.plugins.registry()} flush>
    {#snippet actions()}
      <Button size="sm" onclick={saveToggles} disabled={!togglesDirty}>{$LL.common.save()}</Button>
    {/snippet}
    <DataTable columns={registryColumns} items={plugins} rowKey={(p) => p.name}>
      {#snippet row(p)}
        <Table.Cell><code>{p.name}</code></Table.Cell>
        <Table.Cell>{p.publisher}</Table.Cell>
        <Table.Cell><Checkbox bind:checked={toggles[p.name]} aria-label={p.name} /></Table.Cell>
      {/snippet}
    </DataTable>
  </Section>

  <Section title={$LL.plugins.credentials()} flush>
    {#snippet actions()}
      {#if scopeOptions.length > 0}
        <AddDialog
          title={$LL.plugins.addKey()}
          submitLabel={$LL.plugins.setKey()}
          canSubmit={Boolean(credKey.trim()) && (credScope !== 'repo' || Boolean(credRepositoryId))}
          onsubmit={saveCredential}
        >
          <FormField label={$LL.plugins.service()}>
            <SelectField options={plugins.map((p) => ({ value: p.name, label: p.name }))} bind:value={credService} />
          </FormField>
          <FormField label={$LL.col.scope()}>
            <SelectField options={scopeOptions} bind:value={credScope} />
          </FormField>
          {#if credScope === 'repo'}
            <FormField label={$LL.plugins.repository()}>
              <SelectField
                options={repos.map((r) => ({ value: String(r.id), label: `${r.namespace}/${r.name}` }))}
                placeholder={String($LL.plugins.repository())}
                bind:value={credRepositoryId}
              />
            </FormField>
          {/if}
          <FormField label={$LL.plugins.apiKey()}>
            <Input type="password" bind:value={credKey} autocomplete="off" />
          </FormField>
        </AddDialog>
      {/if}
    {/snippet}
    {#if allCreds.length === 0}
      <div class="px-5"><EmptyState title={$LL.plugins.noCredentials()} compact /></div>
    {:else}
      <DataTable columns={credColumns} items={allCreds} rowKey={(c) => `${c.scope}:${c.service}:${c.repositoryId ?? ''}`}>
        {#snippet row(c)}
          <Table.Cell><code>{c.service}</code></Table.Cell>
          <Table.Cell>{scopeLabel(c)}</Table.Cell>
          <Table.Cell class="tabular-nums">{new Date(c.updatedAt).toLocaleString()}</Table.Cell>
          <Table.Cell class="text-right">
            <Button variant="destructive" size="sm" onclick={() => removeCredential(c)}>{$LL.plugins.remove()}</Button>
          </Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </Section>
{/if}
