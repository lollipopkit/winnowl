<script lang="ts">
  import { api, type MemberRow, type InviteRow } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDate } from '$lib/format';
  import { me } from '$lib/me';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import DataTable, { type Column } from '$lib/components/DataTable.svelte';

  import * as Table from '$lib/components/ui/table/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import SelectField from '$lib/components/SelectField.svelte';
  import FormField from '$lib/components/FormField.svelte';
  import AddDialog from '$lib/components/AddDialog.svelte';
  import Section from '$lib/components/Section.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

  let members = $state<MemberRow[] | null>(null);
  let invites = $state<InviteRow[] | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // With SMTP configured the backend emails the invite; otherwise the admin hands out the token.
  let inviteEmail = $state('');
  let inviteRole = $state<string>('member');
  let inviteToken = $state<string | null>(null);
  let inviteEmailSent = $state(false);


  async function reload(): Promise<void> {
    error = null;
    try {
      [members, invites] = await Promise.all([api.members(), api.invites()]);
    } catch (e) {
      error = String(e);
    }
  }
  void reload();

  async function run(op: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = null;
    try {
      await op();
      await reload();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  // Errors propagate to the dialog, which keeps the form and shows them inline.
  async function invite(): Promise<void> {
    inviteToken = null;
    inviteEmailSent = false;
    // The invitee's language is unknown, so use the inviter's UI locale.
    const r = await api.inviteMember({ email: inviteEmail, role: inviteRole, locale: $locale });
    inviteToken = r.token;
    inviteEmailSent = r.emailSent;
    inviteEmail = '';
    await reload();
  }

  const memberColumns = $derived<Column[]>([
    { key: 'email', label: $LL.team.email() },
    { key: 'role', label: $LL.team.role() },
    { key: 'status', label: $LL.team.status() },
    { key: 'createdAt', label: $LL.team.joinedAt() },
    { key: 'actions', label: '' },
  ]);
  const inviteColumns = $derived<Column[]>([
    { key: 'email', label: $LL.team.email() },
    { key: 'role', label: $LL.team.role() },
    { key: 'expiresAt', label: $LL.team.expiresAt() },
  ]);
</script>

{#if error}<ErrorText message={error} />{/if}

<Section title={$LL.team.members()} flush>
  {#snippet actions()}
    <AddDialog
      title={$LL.team.invite()}
      submitLabel={$LL.team.sendInvite()}
      canSubmit={Boolean(inviteEmail)}
      onsubmit={invite}
    >
      <FormField label={$LL.team.email()}>
        <Input type="email" placeholder={$LL.team.emailPlaceholder()} bind:value={inviteEmail} />
      </FormField>
      <FormField label={$LL.team.role()}>
        <SelectField options={ROLES.map((r) => ({ value: r, label: r }))} bind:value={inviteRole} />
      </FormField>
    </AddDialog>
  {/snippet}
  {#if members === null}
    <div class="p-5"><Loading /></div>
  {:else if members.length === 0}
    <EmptyState title={$LL.team.noMembers()} />
  {:else}
    <DataTable columns={memberColumns} items={members} rowKey={(m) => m.userId}>
    {#snippet row(m)}
      <Table.Cell>{m.email}{#if m.displayName}<span class="meta"> · {m.displayName}</span>{/if}</Table.Cell>
      <Table.Cell>
        <SelectField options={[...ROLES.map((r) => ({ value: String(r), label: String(r) }))]} value={m.role} disabled={busy || m.userId === $me?.userId} onchange={(v) => run(() => api.changeMemberRole(m.userId, v))} />
      </Table.Cell>
      <Table.Cell>{m.status}</Table.Cell>
      <Table.Cell>{formatDate(m.createdAt, $locale)}</Table.Cell>
      <Table.Cell>
        <Button variant="destructive" disabled={busy || m.userId === $me?.userId} onclick={() => run(() => api.removeMember(m.userId))}>
          {$LL.team.remove()}
        </Button>
      </Table.Cell>
      {/snippet}
    </DataTable>
  {/if}
</Section>

{#if inviteToken || (invites !== null && invites.length > 0)}
  <Section title={$LL.team.pendingInvites()}>
    {#if inviteToken}
      {#if inviteEmailSent}
        <p class="text-muted-foreground m-0 text-sm">{$LL.team.inviteEmailSent()}</p>
      {:else}
        <p class="text-muted-foreground m-0 text-sm">{$LL.team.inviteTokenHint()}</p>
        <pre class="bg-muted mt-2 overflow-x-auto rounded-md p-3 text-xs"><code>{inviteToken}</code></pre>
      {/if}
    {/if}
    {#if invites !== null && invites.length > 0}
      <DataTable columns={inviteColumns} items={invites} rowKey={(i) => i.id}>
        {#snippet row(i)}
          <Table.Cell>{i.email}</Table.Cell>
          <Table.Cell>{i.role}</Table.Cell>
          <Table.Cell>{formatDate(i.expiresAt, $locale)}</Table.Cell>
        {/snippet}
      </DataTable>
    {/if}
  </Section>
{/if}
