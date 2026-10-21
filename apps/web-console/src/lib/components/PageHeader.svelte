<script lang="ts">
  /** At most one primary action per header; secondary actions belong to their Section. */
  import type { Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import PageTabs, { type PageTab } from './PageTabs.svelte';
  import { isTabActive } from '$lib/tabs';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { openSearch } from './SearchPalette.svelte';
  import Search from '@lucide/svelte/icons/search';

  let {
    title,
    description,
    parent,
    tabs,
    tabDefaults,
    actions,
  }: {
    /** Omit when the tabs already name the page. */
    title?: string;
    description?: string;
    parent?: { label: string; href: string };
    tabs?: PageTab[];
    /** Default query values for tabs that differ only by query. */
    tabDefaults?: Record<string, string>;
    actions?: Snippet;
  } = $props();

  // Without a title the h1 becomes the active tab's label, visually hidden.
  const inlineTabs = $derived(!title && !description && !parent && (tabs?.length ?? 0) > 0);
  const activeTab = $derived(tabs?.find((t) => isTabActive(t.href, $page.url, tabDefaults ?? {}))?.label ?? '');
</script>

<header class="mb-6">
  <div class={['page-head-row', inlineTabs && 'with-tabs']}>
    <div class="page-head-main">
      {#if parent}
        <nav class="text-muted-foreground mb-1.5 flex items-center gap-1 text-sm" aria-label="breadcrumb">
          <a class="hover:text-foreground" href={parent.href}>{parent.label}</a>
          <span aria-hidden="true">/</span>
        </nav>
      {/if}
      <h1 class={title ? 'mb-0' : 'sr-only'}>{title ?? activeTab}</h1>
      {#if description}
        <p class="text-muted-foreground mt-1 mb-0 max-w-[68ch] text-sm">{description}</p>
      {/if}
      {#if inlineTabs && tabs}<PageTabs {tabs} defaults={tabDefaults ?? {}} flush />{/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if actions}{@render actions()}{/if}
      <button type="button" class="search-trigger" onclick={openSearch} aria-label={$LL.search.open()}>
        <Search class="size-4" />
        <span class="search-trigger-label">{$LL.search.open()}</span>
        <kbd class="search-trigger-kbd">⌘K</kbd>
      </button>
    </div>
  </div>
  {#if tabs && tabs.length > 0 && !inlineTabs}
    <PageTabs {tabs} defaults={tabDefaults ?? {}} />
  {:else if !inlineTabs}
    <Separator class="mt-5" />
  {/if}
</header>
