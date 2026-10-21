<script lang="ts">
  /** Review configuration form shared by the repository and organization config pages. */
  import type { Snippet } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { REVIEW_LANGUAGES } from '@reviewbot/i18n';
  import { resolveProfile, type ReviewProfileName } from '@reviewbot/review-profile';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import SelectField from '$lib/components/SelectField.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Switch } from '$lib/components/ui/switch/index.js';
  import { Slider } from '$lib/components/ui/slider/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Braces from '@lucide/svelte/icons/braces';

  type Settings = Record<string, unknown>;

  let {
    settings,
    readOnly,
    save,
    ondraft,
    intro,
    aside,
  }: {
    /** Effective settings as loaded; read once when the editor mounts. */
    settings: Settings;
    readOnly: boolean;
    /** Persists the draft; a rejection is shown as a toast and keeps the draft dirty. */
    save: (draft: Settings) => Promise<void>;
    ondraft?: (draft: Settings) => void;
    /** Rendered above the form groups. */
    intro?: Snippet;
    /** Side panel next to the form. */
    aside?: Snippet;
  } = $props();

  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  // Pages mount the editor once the settings have loaded, so only the initial value matters.
  // svelte-ignore state_referenced_locally
  let base = $state<Settings>(clone(settings));
  // svelte-ignore state_referenced_locally
  let draft = $state<Settings>(clone(settings));
  let saving = $state(false);
  let showAdvanced = $state(false);
  let rawOpen = $state(false);
  let rawText = $state('');
  let rawError = $state('');

  $effect(() => ondraft?.(draft));

  function get(path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Settings)[k] : undefined), draft);
  }

  /** `undefined` removes the key so it falls back to the profile or schema default. */
  function set(path: string, value: unknown): void {
    if (readOnly) return;
    const next = clone(draft);
    const keys = path.split('.');
    let cur = next;
    for (const k of keys.slice(0, -1)) {
      if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k] as Settings;
    }
    if (value === undefined) delete cur[keys.at(-1)!];
    else cur[keys.at(-1)!] = value;
    draft = next;
  }

  const bool = (path: string, dflt: boolean): boolean => (typeof get(path) === 'boolean' ? (get(path) as boolean) : dflt);
  const str = (path: string, dflt: string): string => (typeof get(path) === 'string' ? (get(path) as string) : dflt);
  const num = (path: string): number | undefined => (typeof get(path) === 'number' ? (get(path) as number) : undefined);

  function leaves(v: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, child] of Object.entries(v)) leaves(child, prefix ? `${prefix}.${k}` : k, out);
    } else out.set(prefix, JSON.stringify(v));
    return out;
  }
  const dirty = $derived.by(() => {
    const a = leaves(base);
    const b = leaves(draft);
    let n = 0;
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) n += 1;
    return n;
  });

  const PROFILES = ['conservative', 'balanced', 'thorough'] as const;
  const profile = $derived(str('reviews.profile', 'balanced'));
  const profileDefaults = $derived(resolveProfile((PROFILES as readonly string[]).includes(profile) ? (profile as ReviewProfileName) : 'balanced'));
  const profileLabel = (p: string): string =>
    p === 'conservative' ? $LL.config.pConservative() : p === 'thorough' ? $LL.config.pThorough() : $LL.config.pBalanced();
  const profileHint = $derived(
    profile === 'conservative' ? $LL.config.hintConservative() : profile === 'thorough' ? $LL.config.hintThorough() : $LL.config.hintBalanced(),
  );
  const inlineMax = $derived(num('reviews.publication.max_inline_comments'));

  // Keep a yaml-provided value selectable instead of silently rewriting it.
  const withCurrent = (options: string[], current: string): string[] => (options.includes(current) ? options : [current, ...options]);
  const languages = $derived(withCurrent([...REVIEW_LANGUAGES], str('language', 'en')));
  const languageName = $derived.by(() => {
    const names = new Intl.DisplayNames([$locale], { type: 'language' });
    return (code: string): string => {
      try {
        return names.of(code) ?? code;
      } catch {
        return code;
      }
    };
  });
  const perFile = $derived(withCurrent(['1', '2', '3', '5'], String(num('reviews.publication.max_inline_per_file') ?? 3)));
  const depth = $derived(withCurrent(['2', '4', '8'], String(num('reviews.scope.max_dependency_depth') ?? 4)));
  const NETWORK = ['none', 'package-registry-only', 'allowlist', 'full'] as const;
  const networkLabel = (v: string): string =>
    ({ none: $LL.config.netNone(), 'package-registry-only': $LL.config.netRegistry(), allowlist: $LL.config.netAllowlist(), full: $LL.config.netFull() })[v] ?? v;

  async function onSave(): Promise<void> {
    saving = true;
    try {
      const snapshot = clone(draft);
      await save(snapshot);
      base = snapshot;
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      saving = false;
    }
  }

  function openRaw(): void {
    rawText = JSON.stringify(draft, null, 2);
    rawError = '';
    rawOpen = true;
  }
  function applyRaw(): void {
    try {
      const parsed: unknown = JSON.parse(rawText || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      draft = parsed as Settings;
      rawOpen = false;
    } catch {
      rawError = $LL.config.jsonInvalid();
    }
  }
</script>

{#snippet row(label: string, hint: string | null, control: Snippet)}
  <div class="setting-row">
    <div class="setting-label">
      <span>{label}</span>
      {#if hint}<small>{hint}</small>{/if}
    </div>
    <div class="setting-control">{@render control()}</div>
  </div>
{/snippet}

{#snippet toggle(path: string, dflt: boolean, label: string, hint: string | null = null)}
  {#snippet control()}
    <Switch checked={bool(path, dflt)} disabled={readOnly} onCheckedChange={(v) => set(path, v)} aria-label={label} />
  {/snippet}
  {@render row(label, hint, control)}
{/snippet}

{#snippet segmented(path: string, value: string, options: { value: string; label: string }[], numeric = false)}
  <ToggleGroup.Root
    type="single"
    variant="outline"
    size="sm"
    {value}
    disabled={readOnly}
    onValueChange={(v) => v && set(path, numeric ? Number(v) : v)}
  >
    {#each options as o (o.value)}<ToggleGroup.Item class="seg-item" value={o.value}>{o.label}</ToggleGroup.Item>{/each}
  </ToggleGroup.Root>
{/snippet}

<div class="settings-layout">
  <div class="settings-main">
    {@render intro?.()}

    <section class="settings-group">
      <h2>{$LL.config.gReview()}</h2>
      {#snippet presetControl()}
        {@render segmented('reviews.profile', profile, PROFILES.map((p) => ({ value: p, label: profileLabel(p) })))}
      {/snippet}
      {@render row($LL.config.profile(), profileHint, presetControl)}
      {@render toggle('reviews.auto.enabled', true, $LL.config.autoReview(), $LL.config.autoReviewHint())}
      {@render toggle('reviews.auto.drafts', false, $LL.config.reviewDrafts())}
      {#snippet languageControl()}
        <SelectField class="w-40" options={languages.map((l) => ({ value: l, label: languageName(l) }))} value={str('language', 'en')} disabled={readOnly} onchange={(v) => set('language', v)} />
      {/snippet}
      {@render row($LL.config.language(), null, languageControl)}
    </section>

    <section class="settings-group">
      <h2>{$LL.config.gPublish()}</h2>
      {#snippet inlineControl()}
        <Slider
          type="single"
          class="w-36"
          min={0}
          max={20}
          step={1}
          value={inlineMax ?? profileDefaults.maxInlineComments}
          disabled={readOnly}
          onValueChange={(v) => set('reviews.publication.max_inline_comments', v)}
          aria-label={$LL.config.maxInline()}
        />
        <span class="settings-value">{inlineMax ?? profileDefaults.maxInlineComments}</span>
        {#if inlineMax !== undefined && !readOnly}
          <Button size="sm" variant="ghost" onclick={() => set('reviews.publication.max_inline_comments', undefined)}>
            {$LL.config.followPreset({ n: profileDefaults.maxInlineComments })}
          </Button>
        {/if}
      {/snippet}
      {@render row($LL.config.maxInline(), $LL.config.maxInlineHint(), inlineControl)}
      {@render toggle('reviews.publication.show_unverified_risks', true, $LL.config.showUnverified(), $LL.config.showUnverifiedHint())}
      {#snippet unrelatedControl()}
        {@render segmented('reviews.scope.report_preexisting_unrelated', str('reviews.scope.report_preexisting_unrelated', 'summary'), [
          { value: 'summary', label: $LL.config.unrelatedSummary() },
          { value: 'issue', label: $LL.config.unrelatedIssue() },
          { value: 'off', label: $LL.config.unrelatedOff() },
        ])}
      {/snippet}
      {@render row($LL.config.unrelated(), null, unrelatedControl)}
    </section>

    <section class="settings-group">
      <h2>{$LL.config.gMerge()}</h2>
      {@render toggle('merge_gate.enabled', false, $LL.config.mergeGate(), $LL.config.mergeGateHint())}
      {@render toggle('reviews.block_preexisting', false, $LL.config.blockPreexisting(), $LL.config.blockPreexistingHint())}
      {@render toggle('actions.autofix.enabled', true, $LL.config.autofix(), $LL.config.autofixHint())}
    </section>

    <button type="button" class="settings-more" onclick={() => (showAdvanced = !showAdvanced)} aria-expanded={showAdvanced}>
      {#if showAdvanced}<ChevronUp class="size-4" />{:else}<ChevronDown class="size-4" />{/if}{$LL.config.advanced()}
    </button>
    {#if showAdvanced}
      <section class="settings-group">
        {#snippet perFileControl()}
          {@render segmented('reviews.publication.max_inline_per_file', String(num('reviews.publication.max_inline_per_file') ?? 3), perFile.map((v) => ({ value: v, label: v })), true)}
        {/snippet}
        {@render row($LL.config.perFile(), null, perFileControl)}
        {#snippet depthControl()}
          {@render segmented('reviews.scope.max_dependency_depth', String(num('reviews.scope.max_dependency_depth') ?? 4), depth.map((v) => ({ value: v, label: v })), true)}
        {/snippet}
        {@render row($LL.config.depth(), $LL.config.depthHint(), depthControl)}
        {#snippet networkControl()}
          <SelectField
            class="w-48"
            options={withCurrent([...NETWORK], str('sandbox.network.mode', 'none')).map((v) => ({ value: v, label: networkLabel(v) }))}
            value={str('sandbox.network.mode', 'none')}
            disabled={readOnly}
            onchange={(v) => set('sandbox.network.mode', v)}
          />
        {/snippet}
        {@render row($LL.config.sandboxNet(), $LL.config.sandboxNetHint(), networkControl)}
        {#snippet rawControl()}
          <Button size="sm" variant="outline" onclick={openRaw}><Braces />{$LL.config.rawOpen()}</Button>
        {/snippet}
        {@render row($LL.config.raw(), $LL.config.rawHint(), rawControl)}
      </section>
    {/if}

    {#if dirty > 0 && !readOnly}
      <div class="settings-savebar">
        <span>{$LL.config.unsaved({ n: dirty })}</span>
        <Button size="sm" variant="ghost" onclick={() => (draft = clone(base))}>{$LL.config.revert()}</Button>
        <Button size="sm" disabled={saving} onclick={onSave}>{$LL.common.save()}</Button>
      </div>
    {/if}
  </div>

  {@render aside?.()}
</div>

<Dialog.Root bind:open={rawOpen}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header><Dialog.Title>{$LL.config.raw()}</Dialog.Title></Dialog.Header>
    <Textarea class="code-area" bind:value={rawText} disabled={readOnly} spellcheck="false" />
    {#if rawError}<ErrorText message={rawError} />{/if}
    {#if !readOnly}
      <Dialog.Footer><Button onclick={applyRaw}>{$LL.config.rawApply()}</Button></Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
