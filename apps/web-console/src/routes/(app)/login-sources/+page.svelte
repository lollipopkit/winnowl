<script lang="ts">
  // Operator-only: whoever registers an issuer decides who that instance's users are,
  // so users can only look up registered instances, never add one.
  import { api, type LoginInstanceView } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { me } from '$lib/me';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { platformTabs } from '$lib/tabs';
  import Section from '$lib/components/Section.svelte';
  import ListState from '$lib/components/ListState.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  let items = $state<LoginInstanceView[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionErr = $state('');

  let url = $state('');
  let label = $state('');
  let clientId = $state('');
  let clientSecret = $state('');

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      items = (await api.loginInstances()).items;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
  });

  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function add(): Promise<void> {
    await api.addLoginInstance({ url, ...(label ? { label } : {}), clientId, clientSecret });
    // Drop the client secret from memory once submitted.
    url = label = clientId = clientSecret = '';
    actionErr = '';
    await load();
  }

  async function remove(id: string): Promise<void> {
    actionErr = '';
    try {
      await api.deleteLoginInstance(id);
      await load();
    } catch (e) {
      actionErr = (e as Error).message;
    }
  }
</script>

<PageHeader tabs={platformTabs($LL)} />

{#if $me && !$me.isOperator}<p class="notice">{$LL.common.operatorOnly()}</p>{/if}

{#if actionErr}<ErrorText message={actionErr} />{/if}

<Section title={$LL.loginSources.listTitle()} flush>
  {#snippet actions()}
    <AddDialog
      title={$LL.loginSources.addTitle()}
      submitLabel={$LL.loginSources.add()}
      canSubmit={Boolean(url && clientId && clientSecret)}
      onsubmit={add}
    >
      <FormField label={$LL.loginSources.colUrl()}>
        <Input bind:value={url} placeholder="git.example.com" autocapitalize="none" spellcheck={false} />
      </FormField>
      <FormField label={$LL.loginSources.colLabel()}>
        <Input bind:value={label} placeholder="git.example.com" />
      </FormField>
      <FormField label={$LL.loginSources.colClientId()}>
        <Input bind:value={clientId} autocapitalize="none" spellcheck={false} />
      </FormField>
      <FormField label={$LL.loginSources.colClientSecret()}>
        <Input type="password" bind:value={clientSecret} autocomplete="off" />
      </FormField>
    </AddDialog>
  {/snippet}
  <ListState {loading} error={loadError} empty={items.length === 0} emptyText={$LL.loginSources.empty()}>
    <ul class="m-0 list-none p-0">
      {#each items as i (i.id)}
        <li class="border-border flex flex-wrap items-center gap-3 border-b px-5 py-3.5 last:border-b-0">
          <div class="min-w-0 flex-1">
            <p class="m-0 text-sm font-medium">{i.label}</p>
            <p class="text-muted-foreground m-0 text-xs"><code>{i.issuer}</code> · {i.clientId}</p>
          </div>
          <Button variant="ghost" size="sm" onclick={() => remove(i.id)}>{$LL.loginSources.remove()}</Button>
        </li>
      {/each}
    </ul>
  </ListState>
</Section>
