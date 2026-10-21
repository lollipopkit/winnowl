<script lang="ts">
  /** Column count matches the real table to avoid layout shift when data arrives. */
  import * as Table from '$lib/components/ui/table/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';

  let { columns = 4, rows = 6 }: { columns?: number; rows?: number } = $props();
</script>

<Table.Root aria-hidden="true">
  <Table.Body>
    {#each { length: rows } as _, i (i)}
      <Table.Row>
        {#each { length: columns } as _, j (j)}
          <Table.Cell><Skeleton class="h-3 w-full" /></Table.Cell>
        {/each}
      </Table.Row>
    {/each}
  </Table.Body>
</Table.Root>
