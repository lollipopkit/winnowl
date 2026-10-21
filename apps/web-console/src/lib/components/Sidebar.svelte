<script lang="ts">
  import { page } from '$app/stores';
  import { afterNavigate, goto } from '$app/navigation';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { groupedNav, isNavActive, type NavItem } from '$lib/nav';
  import { NAV_ICONS } from '$lib/nav-icons';
  import { me } from '$lib/me';
  import { inboxPending, refreshInboxCount } from '$lib/inbox';
  import { api } from '$lib/api';
  import { logout, activeTenant, setActiveTenant } from '$lib/auth';
  import BrandMark from './BrandMark.svelte';
  import { currentLocale, switchLocale, LOCALE_NAMES } from '$lib/locale';
  import { locales } from '$lib/i18n/i18n-util';
  import type { Locales } from '$lib/i18n/i18n-types';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import Check from '@lucide/svelte/icons/check';
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import LogOut from '@lucide/svelte/icons/log-out';
  import BookOpen from '@lucide/svelte/icons/book-open';

  const cur = currentLocale();


  const groups = $derived(groupedNav($me));
  const memberships = $derived($me?.memberships ?? []);
  const curTenant = $derived(activeTenant() ?? $me?.tenantId ?? '');
  const curTenantName = $derived(memberships.find((m) => m.tenantId === curTenant)?.tenantName ?? '');

  const who = $derived($me?.displayName ?? $me?.email?.split('@')[0] ?? null);

  let running = $state(0);
  function refreshRunning(): void {
    void api
      .reviewProgress()
      .then((r) => (running = r.items.filter((i) => !i.finishedAt && !i.outcome).length))
      .catch(() => undefined);
  }

  let open = $state(false);
  afterNavigate(() => {
    open = false;
    refreshRunning();
    refreshInboxCount();
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) open = false;
  }

  function active(item: NavItem): boolean {
    return isNavActive(item, $page.url.pathname);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<button
  class="menu-btn"
  class:is-open={open}
  aria-label={$LL.common.menu()}
  aria-expanded={open}
  aria-controls="app-sidebar"
  onclick={() => (open = !open)}
>
  ☰
</button>

{#if open}
  <button class="sidebar-backdrop open" aria-label={$LL.common.close()} onclick={() => (open = false)}></button>
{/if}

<nav
  id="app-sidebar"
  class="sidebar"
  class:open
  role={open ? 'dialog' : undefined}
  aria-modal={open ? 'true' : undefined}
  aria-label={$LL.common.menu()}
>
  <div class="brand">
    <span class="brand-mark"><BrandMark size={22} /></span>
    <span class="brand-name">Winnowl</span>
  </div>

  <div class="nav-list">
    {#each groups as g, gi (g.group)}
      {#if gi > 0}<p class="nav-group">{$LL.navGroup[g.group]()}</p>{/if}
      {#each g.items as item (item.path)}
        {@const Icon = NAV_ICONS[item.icon]}
        <a class="nav-link" href={item.path} aria-current={active(item) ? 'page' : undefined}>
          {#if Icon}<Icon class="size-4 shrink-0 opacity-70" />{/if}
          <span class="nav-label">{$LL.nav[item.key]()}</span>
          {#if item.key === 'inbox' && $inboxPending > 0}
            <span class="nav-badge">{$inboxPending > 99 ? '99+' : $inboxPending}</span>
          {:else if item.key === 'reviews' && running > 0}
            <span class="nav-trailing">{$LL.progress.runningCount({ count: running })}</span>
          {/if}
        </a>
      {/each}
    {/each}
  </div>

  <div class="sidebar-foot">
    <div class="sidebar-user">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="user-trigger">
          <span class="identity-avatar" aria-hidden="true">{(who ?? '?').slice(0, 1).toUpperCase()}</span>
          <span class="identity-text">
            <span class="identity-name">{who ?? '—'}</span>
            <span class="identity-role"
              >{curTenantName || $me?.role || ''}{$me?.isOperator ? ` · ${$LL.navGroup.platform()}` : ''}</span
            >
          </span>
          <ChevronsUpDown class="size-4 shrink-0 opacity-60" />
        </DropdownMenu.Trigger>
        <!-- z-70: above the mobile drawer (55); max-h keeps the upward menu inside the viewport. -->
        <DropdownMenu.Content
          class="z-[70] max-h-(--bits-dropdown-menu-content-available-height) w-60 overflow-y-auto"
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
        >
          {#if memberships.length > 1}
            <DropdownMenu.Label>{$LL.common.tenant()}</DropdownMenu.Label>
            {#each memberships as m (m.tenantId)}
              <DropdownMenu.Item onSelect={() => setActiveTenant(m.tenantId)}>
                <span class="flex-1 truncate">{m.tenantName}</span>
                {#if m.tenantId === curTenant}<Check class="size-4" />{/if}
              </DropdownMenu.Item>
            {/each}
            <DropdownMenu.Separator />
          {/if}

          <DropdownMenu.Label>{$LL.common.language()}</DropdownMenu.Label>
          {#each locales as l (l)}
            <DropdownMenu.Item onSelect={() => switchLocale(l as Locales)}>
              <span class="flex-1">{LOCALE_NAMES[l] ?? l.toUpperCase()}</span>
              {#if l === cur}<Check class="size-4" />{/if}
            </DropdownMenu.Item>
          {/each}

          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => goto('/docs')}>
            <BookOpen class="size-4" />
            {$LL.nav.docs()}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={logout}>
            <LogOut class="size-4" />
            {$LL.common.logout()}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </div>
</nav>
