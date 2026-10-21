<script lang="ts">
  /** error/loading/empty states for list pages; renders children with data. */
  import type { Snippet } from 'svelte';
  import { LL } from '$lib/i18n/i18n-svelte';
  import ErrorText from './ErrorText.svelte';
  import SkeletonTable from './SkeletonTable.svelte';
  import EmptyState from './EmptyState.svelte';

  let {
    error,
    loading,
    empty,
    emptyText,
    emptyHint,
    skeletonColumns = 4,
    children,
  }: {
    error: string | null | undefined;
    loading: boolean;
    empty: boolean;
    emptyText?: string;
    /** Why it is empty / what to do next. Leave unset if there is nothing true to say. */
    emptyHint?: string;
    skeletonColumns?: number;
    children: Snippet;
  } = $props();
</script>

{#if error}
  <ErrorText message={error} />
{:else if loading}
  <SkeletonTable columns={skeletonColumns} />
{:else if empty}
  <EmptyState title={emptyText ?? $LL.list.empty()} description={emptyHint} />
{:else}
  {@render children()}
{/if}
