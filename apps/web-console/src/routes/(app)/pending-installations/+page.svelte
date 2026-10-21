<script lang="ts">
  import { api, type PendingInstallationView } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDateTime } from '$lib/format';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import { me } from '$lib/me';

  // Installs by accounts outside the allowlist only create a pending record that an operator approves here.
  let items = $state<PendingInstallationView[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let actionErr = $state('');
  let busy = $state('');
  let status = $state('pending');

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      items = (await api.pendingInstallations(status || undefined)).items;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void status;
    void load();
  });

  async function decide(id: string, action: 'approve' | 'reject'): Promise<void> {
    busy = id;
    actionErr = '';
    try {
      await api.decidePendingInstallation(id, action);
      await load();
    } catch (e) {
      actionErr = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  const forbidden = $derived(loadError !== null && loadError.startsWith('403'));
</script>

<PageHeader title={$LL.nav.pendingInstallations()} />

{#if $me && !$me.isOperator}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{/if}
{#if actionErr}<ErrorText message={actionErr} />{/if}

<Section flush>
  <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
    <SelectField
      options={[
        { value: 'pending', label: $LL.pendingInstall.statusPending() },
        { value: 'approved', label: $LL.pendingInstall.statusApproved() },
        { value: 'rejected', label: $LL.pendingInstall.statusRejected() },
        { value: '', label: $LL.list.all() },
      ]}
      bind:value={status}
    />
    <span class="text-muted-foreground ml-auto text-sm">{$LL.list.total({ total: items.length })}</span>
  </div>

  {#if forbidden}
    <p class="empty-cell">{$LL.common.operatorOnly()}</p>
  {:else if loadError}
    <div class="p-5"><ErrorText message={loadError} /></div>
  {:else if loading && items.length === 0}
    <div class="p-5"><Loading /></div>
  {:else if items.length === 0}
    <EmptyState title={$LL.pendingInstall.empty()} />
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>{$LL.col.account()}</Table.Head>
          <Table.Head>{$LL.pendingInstall.installer()}</Table.Head>
          <Table.Head>{$LL.col.status()}</Table.Head>
          <Table.Head>{$LL.col.created()}</Table.Head>
          <Table.Head></Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each items as p (p.id)}
          <Table.Row>
            <Table.Cell>
              {p.accountLogin}
              <span class="text-muted-foreground"> · {p.provider}</span>
            </Table.Cell>
            <Table.Cell>{p.installerLogin}</Table.Cell>
            <Table.Cell><Badge value={p.status} /></Table.Cell>
            <Table.Cell>{formatDateTime(p.createdAt, $locale)}</Table.Cell>
            <Table.Cell class="text-right">
              {#if p.status === 'pending'}
                <div class="inline-actions justify-end">
                  <Button size="sm" disabled={busy === p.id} onclick={() => decide(p.id, 'approve')}>
                    {$LL.common.approve()}
                  </Button>
                  <Button variant="destructive" size="sm" disabled={busy === p.id} onclick={() => decide(p.id, 'reject')}>
                    {$LL.common.reject()}
                  </Button>
                </div>
              {:else}
                <span class="text-muted-foreground text-sm">{p.decidedBy ?? '—'}</span>
              {/if}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</Section>
