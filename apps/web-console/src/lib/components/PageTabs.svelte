<script lang="ts" module>
  export interface PageTab {
    label: string;
    href: string;
  }
</script>

<script lang="ts">
  /**
   * Sub-view tabs: only for sibling views of the same object (cross-object navigation is the sidebar).
   * Rendered as links so each sub-view keeps its own URL (deep links, reload, back).
   */
  import { page } from '$app/stores';
  import { isTabActive } from '$lib/tabs';

  let {
    tabs,
    defaults = {},
    flush = false,
  }: {
    tabs: PageTab[];
    defaults?: Record<string, string>;
    /** Sticks to the top when no title is visible above (see PageHeader). */
    flush?: boolean;
  } = $props();

  const isActive = (href: string): boolean => isTabActive(href, $page.url, defaults);
</script>

<nav class={['page-tabs', flush && 'flush']} aria-label="sub-navigation">
  {#each tabs as t (t.href)}
    <a class="page-tab" href={t.href} aria-current={isActive(t.href) ? 'page' : undefined}>{t.label}</a>
  {/each}
</nav>
