<script lang="ts">
  // config-reference.json is generated from the Zod schema by `pnpm docs:config`; do not hand-edit.
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import Section from '$lib/components/Section.svelte';
  import CodeText from '$lib/components/CodeText.svelte';
  import { ACTIONS_WORKFLOW, ACTIONS_WORKFLOW_PATH } from '$lib/actions-workflow';

  import reference from '$lib/generated/config-reference.json';
  import { CONFIG_DOCS_ZH } from '$lib/config-docs.zh';

  interface ConfigField {
    path: string;
    type: string;
    default?: string;
    description?: string;
  }

  const fields = reference.fields as ConfigField[];

  function describe(f: ConfigField): string {
    if ($locale === 'zh') return CONFIG_DOCS_ZH[f.path] ?? f.description ?? '';
    return f.description ?? '';
  }

  const groups = $derived.by(() => {
    const map = new Map<string, ConfigField[]>();
    for (const f of fields) {
      const top = f.path.includes('.') ? f.path.slice(0, f.path.indexOf('.')) : f.path;
      const list = map.get(top) ?? [];
      list.push(f);
      map.set(top, list);
    }
    return [...map.entries()].map(([name, items]) => ({ name, items }));
  });

  const commands = $derived([
    { cmd: '@winnowl help', body: $LL.docs.cmdHelp() },
    { cmd: '@winnowl review', body: $LL.docs.cmdReview() },
    { cmd: '@winnowl fix', body: $LL.docs.cmdFix() },
    { cmd: '@winnowl explain', body: $LL.docs.cmdExplain() },
    { cmd: '@winnowl verify', body: $LL.docs.cmdVerify() },
    { cmd: '@winnowl challenge', body: $LL.docs.cmdChallenge() },
    { cmd: '@winnowl ignore', body: $LL.docs.cmdIgnore() },
    { cmd: '@winnowl pause', body: $LL.docs.cmdPause() },
    { cmd: '@winnowl run <command>', body: $LL.docs.cmdRun() },
    { cmd: '@winnowl generate tests', body: $LL.docs.cmdGenerate() },
    { cmd: '@winnowl show config', body: $LL.docs.cmdShowConfig() },
    { cmd: '@winnowl propose learning [org|me] <rule>', body: $LL.docs.cmdProposeLearning() },
    { cmd: '@winnowl approve learning <id>', body: $LL.docs.cmdApproveLearning() },
  ]);

  const steps = $derived([
    { title: $LL.docs.setup1Title(), body: $LL.docs.setup1Body() },
    { title: $LL.docs.setup2Title(), body: $LL.docs.setup2Body() },
    { title: $LL.docs.setup3Title(), body: $LL.docs.setup3Body() },
  ]);

  const SCHEMA_LINE = '# yaml-language-server: $schema=https://winnowl.lollipopkit.com/winnowl.schema.json';

  const EXAMPLE = `version: 1
language: zh

reviews:
  auto:
    base_branches: [main, release/*]
    max_changed_files: 200
  publication:
    max_inline_comments: 6
  ignored_paths:
    - "**/vendor/**"
    - "**/*.lock"

merge_gate:
  enabled: true
  block_on_severity: [critical, high]

actions:
  autofix:
    require_confirmation: false
`;
</script>

<PageHeader title={$LL.nav.docs()} />

<Section title={$LL.docs.setupTitle()}>
  <ol class="m-0 grid list-none gap-5 p-0">
    {#each steps as s, i (s.title)}
      <li class="flex gap-3">
        <span class="text-muted-foreground/60 font-heading shrink-0 text-sm font-semibold tabular-nums">
          {String(i + 1).padStart(2, '0')}
        </span>
        <div class="min-w-0">
          <h3 class="m-0 text-sm font-semibold">{s.title}</h3>
          <p class="text-muted-foreground mt-1 mb-0 text-sm leading-relaxed">{s.body}</p>
        </div>
      </li>
    {/each}
  </ol>
</Section>

<Section title={$LL.docs.commandsTitle()} description={$LL.docs.commandsBody()} flush>
  <!-- A list, not a table, so the description column doesn't scroll off on narrow screens -->
  <ul class="m-0 list-none p-0">
    {#each commands as c (c.cmd)}
      <li class="border-border border-b px-5 py-3.5 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,16rem)_1fr] sm:gap-6">
        <code class="text-xs break-all">{c.cmd}</code>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed sm:mt-0">{c.body}</p>
      </li>
    {/each}
  </ul>
</Section>

<Section title=".winnowl.yaml" description={$LL.docs.configBody()}>
  <p class="text-muted-foreground m-0 text-sm">{$LL.docs.configSchemaHint()}</p>
  <pre class="code-block mt-2">{SCHEMA_LINE}</pre>

  <h3 class="mt-6 mb-2 text-sm font-semibold">{$LL.docs.configExampleTitle()}</h3>
  <pre class="code-block">{EXAMPLE}</pre>
</Section>

<Section title={$LL.docs.actionsTitle()} description={$LL.docs.actionsBody()}>
  <ol class="text-muted-foreground m-0 grid gap-2 pl-5 text-sm leading-relaxed">
    <li><CodeText text={$LL.docs.actionsStep1()} /></li>
    <li><CodeText text={$LL.docs.actionsStep2({ path: ACTIONS_WORKFLOW_PATH })} /></li>
    <li><CodeText text={$LL.docs.actionsStep3()} /></li>
  </ol>
  <pre class="code-block mt-4">{ACTIONS_WORKFLOW}</pre>
  <p class="text-muted-foreground mt-4 mb-0 text-sm leading-relaxed">{$LL.docs.actionsLimit()}</p>
</Section>

<Section title={$LL.docs.referenceTitle()} flush>
  {#each groups as g (g.name)}
    <details class="border-border border-b last:border-b-0">
      <summary class="px-5 py-3 text-sm font-semibold">
        <code>{g.name}</code>
        <span class="text-muted-foreground ml-2 font-normal">({g.items.length})</span>
      </summary>
      <ul class="border-border m-0 list-none border-t p-0">
        {#each g.items as f (f.path)}
          <li class="border-border border-b px-5 py-3.5 last:border-b-0 sm:grid sm:grid-cols-[minmax(0,22rem)_1fr] sm:gap-6">
            <div class="min-w-0">
              <code class="text-xs break-all">{f.path}</code>
              <p class="text-muted-foreground/80 mt-1 mb-0 text-[11px]">
                {f.type}{#if f.default !== undefined} · {$LL.docs.colDefault()} {f.default}{/if}
              </p>
            </div>
            <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed sm:mt-0">{describe(f)}</p>
          </li>
        {/each}
      </ul>
    </details>
  {/each}
</Section>
