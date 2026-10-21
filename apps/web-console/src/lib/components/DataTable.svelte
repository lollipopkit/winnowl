<script lang="ts" module>
  export interface Column {
    key: string;
    label: string;
    sortable?: boolean;
    /** Numbers are right-aligned at a fixed width; only the name column flexes. */
    align?: 'end';
  }
</script>

<script lang="ts" generics="T">
  /** Generic table: header with optional sorting; rows come from the `row` snippet. */
  import type { Snippet } from 'svelte';
  import * as Table from '$lib/components/ui/table/index.js';
  import { sortArrow, type SortDir } from '$lib/paging';

  let {
    columns,
    items,
    rowKey,
    sort,
    dir,
    onSort,
    onRowClick,
    selectedKey,
    row,
  }: {
    columns: Column[];
    items: T[];
    rowKey: (item: T) => string | number;
    sort?: string;
    dir?: SortDir;
    onSort?: (field: string) => void;
    onRowClick?: (item: T) => void;
    selectedKey?: string | number | null;
    row: Snippet<[T]>;
  } = $props();
</script>

<Table.Root class="table-sticky">
  <Table.Header>
    <Table.Row>
      {#each columns as col (col.key)}
        {#if col.sortable && onSort}
          <Table.Head
            class={['cursor-pointer select-none', sort === col.key && 'text-foreground', col.align === 'end' && 'text-right']}
            onclick={() => onSort(col.key)}
          >{col.label}{sort && dir ? sortArrow({ sort, dir }, col.key) : ''}</Table.Head>
        {:else}
          <Table.Head class={col.align === 'end' ? 'text-right' : ''}>{col.label}</Table.Head>
        {/if}
      {/each}
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each items as item (rowKey(item))}
      {#if onRowClick}
        <Table.Row
          class={['row-click', selectedKey === rowKey(item) && 'row-on']}
          tabindex={0}
          onclick={() => onRowClick(item)}
          onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && onRowClick(item)}
        >
          {@render row(item)}
        </Table.Row>
      {:else}
        <Table.Row>
          {@render row(item)}
        </Table.Row>
      {/if}
    {/each}
  </Table.Body>
</Table.Root>
