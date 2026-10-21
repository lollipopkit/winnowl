<script lang="ts">
  import type { Snippet } from 'svelte';
  /** Shell for public pages (landing/docs), applied by the layout only when logged out; logged-in users get the app shell. */
  import { LL } from '$lib/i18n/i18n-svelte';
  import { currentLocale, switchLocale, LOCALE_NAMES } from '$lib/locale';
  import { locales } from '$lib/i18n/i18n-util';
  import type { Locales } from '$lib/i18n/i18n-types';
  import BrandMark from './BrandMark.svelte';
  import LoginDialog from './LoginDialog.svelte';
  import { loginDialog, openLogin } from '$lib/login-dialog.svelte.js';

  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';

  let { children }: { children: Snippet } = $props();

  const cur = currentLocale();

  // Failed logins redirect to `/?auth_error=…`: open the dialog so the error shows above the login buttons.
  $effect(() => {
    if (new URLSearchParams(location.search).has('auth_error')) openLogin();
  });
</script>

<div class="bg-background text-foreground min-h-dvh">
  <header class="mx-auto flex max-w-5xl items-center justify-between px-5 py-5 sm:px-8">
    <a class="flex items-center gap-2 hover:no-underline" href="/">
      <span class="brand-mark"><BrandMark size={22} /></span>
      <!-- Product name is not localized. -->
      <span class="font-heading text-base font-semibold tracking-tight">Winnowl</span>
    </a>
    <div class="flex items-center gap-2">
      <a class={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/docs">{$LL.nav.docs()}</a>
      <Button size="sm" onclick={openLogin}>{$LL.landing.signIn()}</Button>
    </div>
  </header>

  <main class="mx-auto max-w-5xl px-5 pb-20 sm:px-8">
    {@render children()}
  </main>

  <footer class="border-border border-t">
    <div
      class="text-muted-foreground mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-5 text-sm sm:px-8"
    >
      <span>{$LL.landing.tagline()}</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })} aria-label={$LL.common.language()}>
          {LOCALE_NAMES[cur] ?? cur.toUpperCase()}
          <ChevronDown class="size-3.5 opacity-60" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Content class="w-40" align="end" side="top">
          {#each locales as l (l)}
            <DropdownMenu.Item onSelect={() => switchLocale(l as Locales)}>
              <span class="flex-1">{LOCALE_NAMES[l] ?? l.toUpperCase()}</span>
              {#if l === cur}<Check class="size-4" />{/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </footer>
</div>

<LoginDialog bind:open={loginDialog.open} />
