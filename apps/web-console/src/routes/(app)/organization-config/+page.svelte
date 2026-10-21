<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { api } from '$lib/api';
  import { me, roleAtLeast } from '$lib/me';
  import { LL } from '$lib/i18n/i18n-svelte';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import ConfigEditor from '$lib/components/ConfigEditor.svelte';

  let settings = $state<Record<string, unknown> | null>(null);
  let loadError = $state<string | null>(null);

  api
    .organizationConfig()
    .then((c) => (settings = c.settings))
    .catch((e: Error) => (loadError = e.message));

  const readOnly = $derived(!roleAtLeast($me?.role, 'admin'));

  async function save(draft: Record<string, unknown>): Promise<void> {
    await api.saveOrganizationConfig(draft);
    toast.success($LL.config.orgSaved(), { description: $LL.config.savedSub() });
  }
</script>

<PageHeader title={$LL.nav.organizationConfig()} />

{#if loadError}
  <ErrorText message={loadError} />
{:else if !settings}
  <Loading />
{:else}
  <ConfigEditor {settings} {readOnly} {save}>
    {#snippet intro()}
      <p class="text-muted-foreground m-0">{$LL.config.orgIntro({ usage: $LL.nav.usage() })}</p>
    {/snippet}
  </ConfigEditor>
{/if}
