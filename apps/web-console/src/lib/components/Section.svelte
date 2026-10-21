<script lang="ts">
  /**
   * Content section: title, description, top-right actions and carded content. Page content must live in a Section.
   * `flush` (for tables) removes the content padding and the table's own border to avoid nested borders.
   */
  import type { Snippet } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';

  let {
    title,
    description,
    actions,
    flush = false,
    children,
  }: {
    title?: string;
    description?: string;
    actions?: Snippet;
    flush?: boolean;
    /** Optional: when omitted, the content area and the header's bottom border are not rendered. */
    children?: Snippet;
  } = $props();
</script>

<Card.Root class="mb-5 gap-0 py-0">
  {#if title || actions}
    <Card.Header class={['[.border-b]:pb-4 gap-1 px-5 pt-5', children ? 'border-b pb-4' : 'pb-5']}>
      {#if title}<Card.Title class="text-base leading-none font-semibold">{title}</Card.Title>{/if}
      {#if description}
        <Card.Description class="max-w-[68ch] text-sm">{description}</Card.Description>
      {/if}
      {#if actions}
        <!-- Wrap and right-align: some headers carry several controls that would squeeze the title on narrow screens. -->
        <Card.Action class="flex flex-wrap items-center justify-end gap-2">{@render actions()}</Card.Action>
      {/if}
    </Card.Header>
  {/if}
  {#if children}
    <Card.Content class={flush ? 'p-0 [&_table]:border-0' : 'p-5'}>
      {@render children()}
    </Card.Content>
  {/if}
</Card.Root>
