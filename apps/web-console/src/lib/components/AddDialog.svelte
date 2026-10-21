<script lang="ts">
  /** The single "add" pattern: a plus button at the top right of its container opens the form (see FormDialog). */
  import type { Snippet } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import Plus from '@lucide/svelte/icons/plus';
  import FormDialog from './FormDialog.svelte';

  let {
    title,
    description,
    submitLabel,
    canSubmit = true,
    onsubmit,
    children,
  }: {
    /** Also the plus button's accessible name. */
    title: string;
    description?: string;
    submitLabel: string;
    canSubmit?: boolean;
    onsubmit: () => Promise<unknown>;
    children: Snippet;
  } = $props();
</script>

<FormDialog {title} {description} {submitLabel} {canSubmit} {onsubmit} {children}>
  {#snippet trigger(show: () => void)}
    <Button size="icon-sm" aria-label={title} {title} onclick={show}>
      <Plus aria-hidden="true" />
    </Button>
  {/snippet}
</FormDialog>
