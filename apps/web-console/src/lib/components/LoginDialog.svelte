<script lang="ts">
  /**
   * Login redirects to the backend `/v1/auth/<source>/start`; the SPA never handles credentials.
   * Self-hosted instances are picked from the registered list, never typed in, so the site cannot vouch for a phishing host;
   * picking requires an explicit continue so a misclick does not leave the site.
   */
  import { LL } from '$lib/i18n/i18n-svelte';
  import { authProviders, startLogin, type AuthProvider } from '$lib/auth';

  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import SelectField from '$lib/components/SelectField.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let busy = $state(false);
  let providers = $state<AuthProvider[]>([]);
  let instanceId = $state('');
  // The backend redirects back with a short error code only. Reads `location` directly because the dialog renders outside the route guard.
  const authError = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('auth_error');

  const builtins = $derived(providers.filter((p) => p.login && p.kind === 'builtin'));
  const instances = $derived(providers.filter((p) => p.login && p.kind === 'instance'));

  $effect(() => {
    void authProviders()
      .then((list) => (providers = list))
      .catch(() => (providers = []));
  });

  function signIn(provider: string): void {
    busy = true;
    startLogin({ provider, next: '/dashboard' });
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>{$LL.landing.signIn()}</Dialog.Title>
    </Dialog.Header>

    <div class="grid gap-2">
      {#each builtins as p (p.id)}
        <Button class="w-full" onclick={() => signIn(p.id)} disabled={busy}>
          {busy ? $LL.login.submitting() : $LL.login.submitWith({ provider: p.label })}
        </Button>
      {/each}

      <!-- Only registered instances; hidden entirely when none are registered. -->
      {#if instances.length > 0}
        <div class="border-border mt-2 flex gap-2 border-t pt-4">
          <SelectField
            class="grow"
            options={instances.map((p) => ({ value: p.id, label: p.label }))}
            bind:value={instanceId}
            placeholder={String($LL.login.instanceSelect())}
          />
          <Button variant="outline" disabled={busy || instanceId === ''} onclick={() => signIn(instanceId)}>{$LL.login.instanceGo()}</Button>
        </div>
      {/if}

      {#if builtins.length === 0 && instances.length === 0}
        <p class="err small m-0">{$LL.login.noProviders()}</p>
      {/if}
      {#if authError}<p class="err small m-0">{$LL.login.failed({ code: authError })}</p>{/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
