<script lang="ts">
  import FormDialog from '../../src/lib/components/FormDialog.svelte';

  let { onsubmit, onopen }: { onsubmit: () => Promise<unknown>; onopen?: () => void } = $props();
  let value = $state('');
</script>

<FormDialog title="Review" submitLabel="Approve" canSubmit={value.length > 0} {onopen} {onsubmit}>
  {#snippet trigger(show: () => void)}
    <button type="button" onclick={show}>Open review</button>
  {/snippet}
  <input aria-label="claim" bind:value />
</FormDialog>
