<script lang="ts">
  /** Label + control stacked vertically; use `.form-row` to lay out several horizontally. */
  import type { Snippet } from 'svelte';
  import { Label } from '$lib/components/ui/label/index.js';

  let { label, hint, children }: { label: string; hint?: string; children: Snippet } = $props();
</script>

<Label class="flex flex-col items-start gap-1.5">
  <span class="text-muted-foreground text-xs font-normal">{label}</span>
  {@render children()}
  {#if hint}<span class="text-muted-foreground text-xs font-normal">{hint}</span>{/if}
</Label>
