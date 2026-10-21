<script lang="ts">
  import { page } from '$app/stores';
  import { api } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { setActiveTenant } from '$lib/auth';
  import ErrorText from '$lib/components/ErrorText.svelte';

  import { Button } from '$lib/components/ui/button/index.js';
  import PageHeader from '$lib/components/PageHeader.svelte';
  // The backend checks the token and that the invite email matches the signed-in user.
  const token = $page.params.token!;
  let busy = $state(false);
  let error = $state<string | null>(null);
  let accepted = $state<{ tenantId: string; role: string } | null>(null);

  async function accept(): Promise<void> {
    busy = true;
    error = null;
    try {
      accepted = await api.acceptInvite(token);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function enter(): void {
    // Full reload so memberships and nav are recomputed for the new tenant.
    setActiveTenant(accepted!.tenantId);
  }
</script>

<PageHeader title={$LL.invite.title()} />

{#if accepted}
  <p>{$LL.invite.accepted({ role: accepted.role })}</p>
  <Button onclick={enter}>{$LL.invite.enter()}</Button>
{:else}
  <p class="meta">{$LL.invite.hint()}</p>
  {#if error}<ErrorText message={error} />{/if}
  <Button disabled={busy} onclick={accept}>{$LL.invite.accept()}</Button>
{/if}
