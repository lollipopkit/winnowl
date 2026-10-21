<script lang="ts">
  /** Skeleton placeholder for non-table content; stable height avoids layout shift. */
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
</script>

<div class="flex flex-col gap-2">
  <Skeleton class="h-4 w-48" />
  <Skeleton class="h-4 w-72" />
  <Skeleton class="h-4 w-40" />
</div>
