<script lang="ts">
  /**
   * Full-screen gate for users with no organisation: every tenant endpoint would return 400/403, so it replaces the
   * app shell. Two states: App not installed (install button from backend config), or installed and awaiting approval.
   */
  import { LL } from '$lib/i18n/i18n-svelte';
  import { logout } from '$lib/auth';
  import type { Me } from '$lib/api';

  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as Card from '$lib/components/ui/card/index.js';
  import Building2 from '@lucide/svelte/icons/building-2';
  import Clock from '@lucide/svelte/icons/clock';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';

  let { me }: { me: Me } = $props();

  const pending = $derived(me.pendingInstallation);
</script>

<div class="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-12">
  <Card.Root class="w-full max-w-xl">
    <Card.Header>
      <div class="text-muted-foreground mb-2 flex items-center gap-2">
        {#if pending}
          <Clock class="size-5" aria-hidden="true" />
        {:else}
          <Building2 class="size-5" aria-hidden="true" />
        {/if}
        <span class="text-xs font-semibold tracking-[0.16em] uppercase">{$LL.onboarding.eyebrow()}</span>
      </div>
      <Card.Title class="font-heading text-2xl">
        {pending ? $LL.onboarding.pendingTitle() : $LL.onboarding.title()}
      </Card.Title>
      <Card.Description class="text-base leading-relaxed">
        {#if pending}
          {$LL.onboarding.pendingBody({ account: pending.accountLogin })}
        {:else}
          {$LL.onboarding.body()}
        {/if}
      </Card.Description>
    </Card.Header>

    <Card.Content class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3">
        {#if pending}
          <Button onclick={() => location.reload()}>
            <RefreshCw class="size-4" aria-hidden="true" />
            {$LL.onboarding.recheck()}
          </Button>
        {:else if me.installUrl}
          <a class={buttonVariants({ variant: 'default' })} href={me.installUrl} rel="noreferrer">
            {$LL.onboarding.install()}
          </a>
          <Button variant="ghost" onclick={() => location.reload()}>{$LL.onboarding.recheck()}</Button>
        {:else}
          <!-- No install URL configured: do not guess a link. -->
          <p class="text-muted-foreground m-0 text-sm">{$LL.onboarding.noInstallUrl()}</p>
        {/if}
      </div>

      <p class="text-muted-foreground m-0 text-sm leading-relaxed">{$LL.onboarding.inviteHint()}</p>
    </Card.Content>

    <Card.Footer class="text-muted-foreground justify-between gap-3 text-sm">
      <span class="truncate">{me.email ?? me.displayName ?? ''}</span>
      <Button variant="ghost" size="sm" onclick={logout}>{$LL.common.logout()}</Button>
    </Card.Footer>
  </Card.Root>
</div>
