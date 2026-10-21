<script lang="ts">
  /**
   * Title, explanation and optional next action.
   * `compact` is for empty cards/sections (left-aligned, short); the default is for a whole empty list.
   */
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    action,
    compact = false,
  }: { title: string; description?: string; action?: Snippet; compact?: boolean } = $props();
</script>

<div class={['flex flex-col gap-2', compact ? 'items-start py-3 text-left' : 'items-center px-6 py-12 text-center']}>
  <p class={['m-0 text-sm', compact ? 'text-muted-foreground' : 'font-medium']}>{title}</p>
  {#if description}
    <p class="text-muted-foreground m-0 max-w-[52ch] text-sm">{description}</p>
  {/if}
  {#if action}<div class={compact ? 'mt-1' : 'mt-2'}>{@render action()}</div>{/if}
</div>
