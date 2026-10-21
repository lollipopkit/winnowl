<script lang="ts">
  import { page } from '$app/stores';
  import { api, type LinkedIdentityView } from '$lib/api';
  import { startLogin } from '$lib/auth';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import { me, roleAtLeast } from '$lib/me';
  import MembersSection from '$lib/components/MembersSection.svelte';
  import InstallationsSection from '$lib/components/InstallationsSection.svelte';

  import * as Table from '$lib/components/ui/table/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Section from '$lib/components/Section.svelte';
  // Linking happens in the backend OAuth callback, which verifies both identities;
  // the frontend never infers identity (no email/username matching).
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let identities = $state<LinkedIdentityView[]>([]);
  let actionErr = $state('');
  const isAdmin = $derived(roleAtLeast($me?.role, 'admin'));

  const justLinked = $derived(Boolean($page.url.searchParams.get('linked')));

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      identities = (await api.identities()).items;
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
  });

  function addIdentity(): void {
    // Link mode: the callback attaches the new identity to the current account; the session is unchanged.
    startLogin({ linkMode: true, next: '/account?linked=1' });
  }

  async function unlink(id: string): Promise<void> {
    actionErr = '';
    try {
      await api.unlinkIdentity(id);
      await load();
    } catch (e) {
      actionErr = (e as Error).message;
    }
  }

  function label(i: LinkedIdentityView): string {
    return i.login ?? i.subject;
  }
  function host(i: LinkedIdentityView): string {
    try {
      return new URL(i.issuer).host;
    } catch {
      return i.issuer;
    }
  }
</script>

<PageHeader title={$LL.nav.account()} />

{#if justLinked}
  <p class="notice ok">{$LL.account.linkedNotice()}</p>
{/if}

<!-- Members and installations need member:manage / installation:manage; identities are the viewer's own. -->
{#if isAdmin}<MembersSection />{/if}

{#if actionErr}<ErrorText message={actionErr} />{/if}

{#if loading && identities.length === 0}
  <Loading />
{:else if loadError}
  <ErrorText message={loadError} />
{:else}
  <Section title={$LL.account.identitiesTitle()} flush>
    {#snippet actions()}
      <Button variant="outline" size="sm" onclick={addIdentity}>{$LL.account.addIdentity()}</Button>
    {/snippet}
    <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>{$LL.account.colKind()}</Table.Head>
        <Table.Head>{$LL.account.colHost()}</Table.Head>
        <Table.Head>{$LL.col.account()}</Table.Head>
        <Table.Head>{$LL.account.colSubject()}</Table.Head>
        <Table.Head></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each identities as i (i.id)}
        <Table.Row>
          <Table.Cell>{i.kind === 'oidc' ? $LL.account.kindLogin() : (i.provider ?? 'provider')}</Table.Cell>
          <Table.Cell><code>{host(i)}</code></Table.Cell>
          <Table.Cell>{label(i)}</Table.Cell>
          <Table.Cell><code>{i.subject}</code></Table.Cell>
          <Table.Cell>
            <!-- Unlinking the last identity would lock the user out (the backend rejects it too) -->
            {#if identities.length > 1}
              <Button type="button" onclick={() => unlink(i.id)}>{$LL.account.unlink()}</Button>
            {:else}
              <span class="meta">{$LL.account.lastIdentity()}</span>
            {/if}
          </Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row><Table.Cell colspan={5}><EmptyState title={$LL.account.none()} /></Table.Cell></Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
  </Section>

  {#if $me?.userId}
    <p class="meta id-foot">{$LL.account.colSubject()}: <code>{$me.userId}</code></p>
  {/if}
{/if}

{#if isAdmin}<InstallationsSection />{/if}
