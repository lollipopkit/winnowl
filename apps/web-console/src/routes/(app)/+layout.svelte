<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { isAuthed } from '$lib/auth';
  import { loadMe, me, needsOnboarding } from '$lib/me';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import PublicShell from '$lib/components/PublicShell.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import SearchPalette from '$lib/components/SearchPalette.svelte';
  import { Toaster } from '$lib/components/ui/sonner/index.js';

  let { children } = $props();

  const authed = isAuthed();
  // Docs are public so evaluators can read them before installing.
  const isPublicPage = $derived($page.url.pathname.startsWith('/docs'));
  // On failure `me` stays null, which applies the most restrictive nav; rendering is not blocked.
  if (authed) void loadMe().catch(() => undefined);
  // No org yet: show onboarding instead of mounting pages whose requests would all 4xx.
  const gated = $derived(needsOnboarding($me, $page.url.pathname));

  // Redirect instead of rendering the landing here, so it has a single canonical URL.
  $effect(() => {
    if (!authed && !isPublicPage) void goto('/', { replaceState: true });
  });
</script>

<svelte:head>
  <title>Winnowl</title>
  <meta name="robots" content="noindex" />
</svelte:head>

{#if authed}
  {#if gated && $me}
    <Onboarding me={$me} />
  {:else}
    <div class="app-shell">
      <Sidebar />
      <main class="content">
        {@render children()}
      </main>
    </div>
    <SearchPalette />
    <Toaster position="bottom-right" />
  {/if}
{:else if isPublicPage}
  <PublicShell>
    {@render children()}
  </PublicShell>
{/if}
