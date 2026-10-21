<script lang="ts">
  import PublicShell from '$lib/components/PublicShell.svelte';

  let { children } = $props();
</script>

<PublicShell>
  {@render children()}
</PublicShell>
