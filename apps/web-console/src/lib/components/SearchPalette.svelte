<script lang="ts" module>
  let openState = $state({ open: false });
  export function openSearch(): void {
    openState.open = true;
  }
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Command from '$lib/components/ui/command/index.js';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { api, type FindingRow, type Repository, type ReviewRun } from '$lib/api';
  import { visibleNav } from '$lib/nav';
  import { NAV_ICONS } from '$lib/nav-icons';
  import { me } from '$lib/me';
  import { severityLabel } from '$lib/labels';

  let query = $state('');
  // Repositories and recent reviews load once and filter locally; findings are queried server-side.
  let repositories = $state<Repository[]>([]);
  let reviews = $state<ReviewRun[]>([]);
  let loaded = false;
  let findings = $state<FindingRow[]>([]);

  $effect(() => {
    if (!openState.open || loaded) return;
    loaded = true;
    void api.repositories({ limit: 200 }).then((r) => (repositories = r.items)).catch(() => undefined);
    void api.reviews({ limit: 50 }).then((r) => (reviews = r.items)).catch(() => undefined);
  });

  let seq = 0;
  $effect(() => {
    const q = query.trim();
    const mine = ++seq;
    if (!q) {
      findings = [];
      return;
    }
    const t = setTimeout(() => {
      void api
        .findings({ q, limit: 6 })
        .then((r) => {
          if (mine === seq) findings = r.items;
        })
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
  });

  const needle = $derived(query.trim().toLowerCase());
  const hit = (s: string): boolean => !needle || s.toLowerCase().includes(needle);
  const pages = $derived(visibleNav($me).filter((i) => hit($LL.nav[i.key]())));
  const repoHits = $derived(repositories.filter((r) => hit(`${r.namespace}/${r.name}`)).slice(0, 6));
  const reviewHits = $derived(
    needle ? reviews.filter((r) => hit(`${r.repository} #${r.changeNumber}`)).slice(0, 6) : [],
  );

  function go(href: string): void {
    openState.open = false;
    query = '';
    void goto(href);
  }

  function onKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openState.open = !openState.open;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- cmdk filtering is off: it matches on `value` only and would drop server-side finding hits. -->
<Command.Dialog
  bind:open={openState.open}
  shouldFilter={false}
  title={$LL.search.open()}
  description={$LL.search.placeholder()}
>
  <Command.Input placeholder={$LL.search.placeholder()} bind:value={query} />
  <Command.List>
    <Command.Empty>{$LL.search.empty()}</Command.Empty>
    {#if reviewHits.length > 0}
      <Command.Group heading={$LL.search.reviews()}>
        {#each reviewHits as r (r.revisionId)}
          <Command.Item value={`review-${r.revisionId}`} onSelect={() => go(`/reviews/${r.revisionId}`)}>
            <span class="flex-1 truncate">{r.repository} #{r.changeNumber}</span>
            <span class="search-meta">{r.headSha.slice(0, 7)}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
    {#if findings.length > 0}
      <Command.Group heading={$LL.search.findings()}>
        {#each findings as f (f.id)}
          <Command.Item value={`finding-${f.id}`} onSelect={() => go(`/findings?finding=${f.id}`)}>
            <span class="flex-1 truncate">{f.claim}</span>
            <span class="search-meta">{severityLabel($LL, f.severity)}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
    {#if repoHits.length > 0}
      <Command.Group heading={$LL.search.repositories()}>
        {#each repoHits as r (r.id)}
          <Command.Item value={`repo-${r.id}`} onSelect={() => go(`/repositories/${r.id}/config`)}>
            <span class="flex-1 truncate">{r.namespace}/{r.name}</span>
            <span class="search-meta">{$LL.search.repoSettings()}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
    {#if pages.length > 0}
      <Command.Group heading={$LL.search.pages()}>
        {#each pages as p (p.path)}
          {@const Icon = NAV_ICONS[p.icon]}
          <Command.Item value={`page-${p.path}`} onSelect={() => go(p.path)}>
            {#if Icon}<Icon class="size-4 opacity-70" />{/if}
            <span class="flex-1 truncate">{$LL.nav[p.key]()}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
