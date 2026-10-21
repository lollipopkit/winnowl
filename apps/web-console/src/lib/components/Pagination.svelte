<script lang="ts">
  import { LL } from '$lib/i18n/i18n-svelte';
  import { Button } from '$lib/components/ui/button/index.js';

  // Controlled: the parent owns offset/limit/total; clicks report the new offset.
  let { offset, limit, total, onpage }: { offset: number; limit: number; total: number; onpage: (offset: number) => void } = $props();

  const from = $derived(total === 0 ? 0 : offset + 1);
  const to = $derived(Math.min(offset + limit, total));
  const canPrev = $derived(offset > 0);
  const canNext = $derived(offset + limit < total);
</script>

<nav class="pager" aria-label={$LL.list.pagination()}>
  <Button variant="outline" size="sm" disabled={!canPrev} onclick={() => onpage(Math.max(0, offset - limit))}>
    {$LL.list.prev()}
  </Button>
  <span class="pager-range" aria-live="polite">{$LL.list.range({ from, to, total })}</span>
  <Button variant="outline" size="sm" disabled={!canNext} onclick={() => onpage(offset + limit)}>
    {$LL.list.next()}
  </Button>
</nav>
