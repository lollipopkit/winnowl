<script lang="ts">
  /** Plain text where `backticked` spans render as code; nothing else is interpreted. */
  let { text }: { text: string } = $props();

  // Odd indexes after splitting on backticks are the code spans.
  const parts = $derived(text.split('`'));
</script>

{#each parts as part, i (i)}{#if i % 2 === 1}<code>{part}</code>{:else}{part}{/if}{/each}
