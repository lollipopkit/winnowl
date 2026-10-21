<script lang="ts">
  import { page } from '$app/stores';
  import { toast } from 'svelte-sonner';
  import { api, type ConfigPreview, type RepositoryConfig } from '$lib/api';
  import { me, roleAtLeast } from '$lib/me';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ConfigEditor from '$lib/components/ConfigEditor.svelte';
  import FileCode from '@lucide/svelte/icons/file-code';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import Split from '@lucide/svelte/icons/split';
  import Ban from '@lucide/svelte/icons/ban';
  import CircleCheck from '@lucide/svelte/icons/circle-check';

  const repositoryId = $page.params.repositoryId!;

  let config = $state<RepositoryConfig | null>(null);
  let loadError = $state<string | null>(null);
  let preview = $state<ConfigPreview | null>(null);

  api
    .repositoryConfig(repositoryId)
    .then((c) => (config = c))
    .catch((e: Error) => (loadError = e.message));

  // Repo yaml wins on the next review, so panel edits would be silently overwritten.
  const readOnly = $derived(config?.source === 'repo-file' || !roleAtLeast($me?.role, 'admin'));

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(previewTimer));

  function onDraft(draft: Record<string, unknown>): void {
    const body = JSON.stringify(draft);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      api
        .previewRepositoryConfig(repositoryId, JSON.parse(body))
        .then((p) => (preview = p))
        .catch(() => {});
    }, 300);
  }

  async function save(draft: Record<string, unknown>): Promise<void> {
    await api.saveRepositoryConfig(repositoryId, draft);
    toast.success($LL.config.saved({ repo: config!.repository }), { description: $LL.config.savedSub() });
  }
</script>

{#if loadError}
  <ErrorText message={loadError} />
{:else if !config}
  <Loading />
{:else}
  <PageHeader title={config.repository.split('/').pop()} parent={{ label: $LL.nav.repositories(), href: '/repositories' }} />

  <ConfigEditor settings={config.settings} {readOnly} {save} ondraft={onDraft}>
    {#snippet intro()}
      <p class="text-muted-foreground m-0">{$LL.config.intro({ repo: config!.repository })}</p>
      {#if config!.source === 'repo-file'}
        <div class="settings-notice"><FileCode class="size-4" /><span>{$LL.config.readOnly()}</span></div>
      {/if}
    {/snippet}
    {#snippet aside()}
      <aside class="settings-preview" aria-label={$LL.config.preview()}>
        <span class="eyebrow">{$LL.config.preview()}</span>
        <div class="settings-preview-card">
          {#if !preview}
            <span class="text-muted-foreground">{$LL.common.loading()}</span>
          {:else if !preview.basis}
            <span class="text-muted-foreground">{$LL.config.previewNone()}</span>
          {:else}
            <span class="settings-preview-basis">{$LL.config.previewBasis({ n: preview.basis.changeNumber, candidates: preview.basis.candidates })}</span>
            {#if preview.inline + preview.summary + preview.notPosted > 0}
              <div class="pv-bar" aria-hidden="true">
                <span class="pv-inline" style:flex-grow={preview.inline}></span>
                <span class="pv-summary" style:flex-grow={preview.summary}></span>
                <span class="pv-dropped" style:flex-grow={preview.notPosted}></span>
              </div>
              <div class="pv-legend">
                <span><i class="legend-dot pv-inline"></i>{$LL.config.legendInline()}</span>
                <span><i class="legend-dot pv-summary"></i>{$LL.config.legendSummary()}</span>
                <span><i class="legend-dot pv-dropped"></i>{$LL.config.legendDropped()}</span>
              </div>
            {/if}
            <ul class="pv-lines">
              <li><MessageSquare class="size-4 text-primary" />{$LL.config.pvInline({ inline: preview.inline, summary: preview.summary })}</li>
              {#if preview.notPosted}<li><EyeOff class="size-4" />{$LL.config.pvNotPosted({ n: preview.notPosted })}</li>{/if}
              <li>
                {#if preview.unverifiedRisks === null}<EyeOff class="size-4" />{$LL.config.pvRisksOff()}
                {:else}<CircleHelp class="size-4" />{$LL.config.pvRisks({ n: preview.unverifiedRisks })}{/if}
              </li>
              <li>
                <Split class="size-4" />{preview.unrelated.mode === 'issue'
                  ? $LL.config.pvUnrelatedIssue()
                  : preview.unrelated.mode === 'off'
                    ? $LL.config.pvUnrelatedOff()
                    : $LL.config.pvUnrelatedSummary()}
              </li>
              <li class={preview.gate === 'block' ? 'text-destructive' : ''}>
                {#if preview.gate === 'block'}<Ban class="size-4" />{$LL.config.pvGateBlock({ n: preview.blocking })}
                {:else if preview.gate === 'pass'}<CircleCheck class="size-4" />{$LL.config.pvGatePass()}
                {:else}<MessageSquare class="size-4" />{$LL.config.pvGateOff({ n: preview.blocking })}{/if}
              </li>
            </ul>
            <small class="text-muted-foreground">{$LL.config.estimateNote()}</small>
          {/if}
        </div>
      </aside>
    {/snippet}
  </ConfigEditor>
{/if}
