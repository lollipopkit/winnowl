<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { api, type PlatformSettingChange, type PlatformSettingView } from '$lib/api';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { formatDateTime } from '$lib/format';
  import { me } from '$lib/me';
  import Loading from '$lib/components/Loading.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { platformTabs } from '$lib/tabs';
  import Section from '$lib/components/Section.svelte';
  import SelectField from '$lib/components/SelectField.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import History from '@lucide/svelte/icons/history';
  // Operator-only: these settings apply to all tenants. Each shows its source (database / env / default).
  let items = $state<PlatformSettingView[] | null>(null);
  let error = $state('');
  let busy = $state('');
  let open = $state<string | null>(null);
  let history = $state<PlatformSettingChange[] | null>(null);

  async function load(): Promise<void> {
    try {
      items = (await api.platformSettings()).items;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  void load();

  async function run(key: string, op: () => Promise<unknown>): Promise<void> {
    busy = key;
    try {
      await op();
      toast.success($LL.common.saved());
      await load();
      if (open === key) await loadHistory(key);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy = '';
    }
  }

  async function loadHistory(key: string): Promise<void> {
    history = null;
    try {
      history = (await api.platformSettingHistory(key)).items;
    } catch (e) {
      toast.error((e as Error).message);
      history = [];
    }
  }
  function toggleHistory(key: string): void {
    open = open === key ? null : key;
    if (open) void loadHistory(key);
  }

  // Setting keys contain dots, so map them to i18n slugs explicitly; unmapped keys fall back to the API's English text.
  const SLUG: Record<string, string> = {
    'review.finding_match': 'findingMatch',
    'review.dedup': 'dedup',
    'review.max_turns': 'maxTurns',
    'review.stage_budget.map': 'budgetMap',
    'review.stage_budget.dig': 'budgetDig',
    'review.stage_budget.verify': 'budgetVerify',
    'review.stage_budget.synthesis': 'budgetSynthesis',
    'review.stale_rounds': 'staleRounds',
    'review.dig_context': 'digContext',
    'review.subagents': 'subagents',
    'review.session_reuse': 'sessionReuse',
    'billing.public_repo': 'publicRepo',
    'fix.validation': 'fixValidation',
    'agent.sandbox': 'agentSandbox',
    'review.verify_votes': 'verifyVotes',
    'review.dig_concurrency': 'digConcurrency',
    'review.auto_continue_rounds': 'autoContinueRounds',
    'review.verify_concurrency': 'verifyConcurrency',
    'review.fast_map': 'fastMap',
    'review.max_tool_calls': 'maxToolCalls',
    'knowledge.select': 'knowledgeSelect',
    'knowledge.inject_all_threshold': 'injectAllThreshold',
    'knowledge.select_cap': 'selectCap',
    'knowledge.global_auto_propose': 'globalAutoPropose',
    'knowledge.global_panel': 'globalPanel',
    'post_merge.enabled': 'postMerge',
    'security.dep_scan': 'depScan',
    'security.static_scan': 'staticScan',
    'security.issue_channel': 'issueChannel',
    'security.issue_disclosure': 'issueDisclosure',
    'security.issue_min_severity': 'issueMinSeverity',
    'byok.enabled': 'byok',
    'quota.warn_ratio': 'quotaWarn',
  };

  type SettingCopy = { name: () => string; desc: () => string };
  const copyOf = (key: string): SettingCopy | undefined => {
    const slug = SLUG[key];
    if (!slug) return undefined;
    return ($LL.platformSetting as unknown as Record<string, SettingCopy>)[slug];
  };

  const titleOf = (s: PlatformSettingView): string => copyOf(s.key)?.name() ?? s.key;
  const descOf = (s: PlatformSettingView): string => copyOf(s.key)?.desc() ?? s.description;

  const sourceLabel = (s: PlatformSettingView): string =>
    s.source === 'database'
      ? $LL.platformSettings.fromDb()
      : s.source === 'environment'
        ? $LL.platformSettings.fromEnv({ env: s.env })
        : $LL.platformSettings.fromDefault();
</script>

<PageHeader tabs={platformTabs($LL)} />

{#if $me && !$me.isOperator}
  <Alert.Root class="mb-5"><Alert.Description>{$LL.common.operatorOnly()}</Alert.Description></Alert.Root>
{/if}
{#if error}<ErrorText message={error} />{/if}

{#if items === null}
  <Loading />
{:else}
  {#each items as s (s.key)}
    {#snippet historyList()}
      {#if history === null}
        <Loading />
      {:else if history.length === 0}
        <p class="text-muted-foreground m-0 text-sm">{$LL.platformSettings.noHistory()}</p>
      {:else}
        <ul class="setting-history">
          {#each history as h (h.changedAt)}
            <li>
              <code>{h.oldValue ?? $LL.platformSettings.inherited()}</code> → <code>{h.newValue ?? $LL.platformSettings.inherited()}</code>
              <span>{h.actor ?? '—'}</span>
              <span class="ml-auto">{formatDateTime(h.changedAt, $locale)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/snippet}
    <Section title={titleOf(s)} description={descOf(s)} children={open === s.key ? historyList : undefined}>
      {#snippet actions()}
        <Button variant="ghost" size="sm" onclick={() => toggleHistory(s.key)} aria-expanded={open === s.key}>
          <History />{$LL.platformSettings.history()}
        </Button>
        {#if s.updatedAt}
          <span class="text-muted-foreground hidden text-xs sm:inline">
            {$LL.platformSettings.changedBy({ by: s.updatedBy ?? '—', at: formatDateTime(s.updatedAt, $locale) })}
          </span>
        {/if}
        <Badge value={sourceLabel(s)} tone={s.source === 'database' ? 'accent' : 'neutral'} />
        <SelectField
          options={s.values.map((v) => ({ value: v, label: v }))}
          value={s.value}
          disabled={busy === s.key}
          onchange={(v) => run(s.key, () => api.savePlatformSetting(s.key, v))}
        />
        {#if s.source === 'database'}
          <Button variant="ghost" size="sm" disabled={busy === s.key} onclick={() => run(s.key, () => api.resetPlatformSetting(s.key))}>
            {$LL.platformSettings.reset()}
          </Button>
        {/if}
      {/snippet}
    </Section>
  {/each}
{/if}
