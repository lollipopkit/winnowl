<script lang="ts">
  import { LL } from '$lib/i18n/i18n-svelte';
  import { openLogin } from '$lib/login-dialog.svelte.js';
  import {
    LANDING_DESCRIPTION,
    LANDING_TITLE,
    OG_IMAGE_PATH,
    REPO_URL,
    SITE_NAME,
    absoluteUrl,
    landingJsonLd,
  } from '$lib/seo';

  import CodeText from '$lib/components/CodeText.svelte';
  import WinnowLedger from '$lib/components/WinnowLedger.svelte';
  import { Button, buttonVariants } from '$lib/components/ui/button/index.js';

  // The stages of one review, in order; titles match the ledger columns above.
  const flow = $derived([
    { title: $LL.landing.stageFound(), body: $LL.landing.flowFoundBody() },
    { title: $LL.landing.stageVerified(), body: $LL.landing.flowVerifiedBody() },
    { title: $LL.landing.stageChallenged(), body: $LL.landing.flowChallengedBody() },
    { title: $LL.landing.stagePosted(), body: $LL.landing.flowPostedBody() },
  ]);

  const rounds = $derived([
    { count: 2, text: $LL.landing.roundsNew(), blocking: false },
    { count: 1, text: $LL.landing.roundsOpen(), blocking: true },
    { count: 3, text: $LL.landing.roundsFixed(), blocking: false },
    { count: 4, text: $LL.landing.roundsFolded(), blocking: false },
  ]);

  // Command words are not localized: they are what people type.
  const commands = $derived([
    { cmd: 'explain', arg: '', body: $LL.landing.cmdExplain() },
    { cmd: 'challenge', arg: '<reason>', body: $LL.landing.cmdChallenge() },
    { cmd: 'resolve', arg: '<why>', body: $LL.landing.cmdResolve() },
    { cmd: 'ignore', arg: '', body: $LL.landing.cmdIgnore() },
    { cmd: 'fix', arg: '', body: $LL.landing.cmdFix() },
    { cmd: 'generate tests', arg: '', body: $LL.landing.cmdTests() },
    { cmd: 'run', arg: '<command>', body: $LL.landing.cmdRun() },
    { cmd: 'propose learning', arg: '<rule>', body: $LL.landing.cmdLearn() },
  ]);

  const more = $derived([
    { title: $LL.landing.gateTitle(), body: $LL.landing.gateBody() },
    { title: $LL.landing.learnTitle(), body: $LL.landing.learnBody() },
    { title: $LL.landing.factsTitle(), body: $LL.landing.factsBody() },
    { title: $LL.landing.modelsTitle(), body: $LL.landing.modelsBody() },
    { title: $LL.landing.largeTitle(), body: $LL.landing.largeBody() },
    { title: $LL.landing.configTitle(), body: $LL.landing.configBody() },
  ]);

  // Steps are numbered because their order matters (install before review).
  const steps = $derived([
    { title: $LL.landing.step1Title(), body: $LL.landing.step1Body() },
    { title: $LL.landing.step2Title(), body: $LL.landing.step2Body() },
  ]);
</script>

<svelte:head>
  <title>{LANDING_TITLE}</title>
  <meta name="description" content={LANDING_DESCRIPTION} />
  <link rel="canonical" href={absoluteUrl('/')} />

  <!-- Social card crawlers run no JS and read only these tags -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={SITE_NAME} />
  <meta property="og:title" content={LANDING_TITLE} />
  <meta property="og:description" content={LANDING_DESCRIPTION} />
  <meta property="og:url" content={absoluteUrl('/')} />
  <meta property="og:image" content={absoluteUrl(OG_IMAGE_PATH)} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={LANDING_TITLE} />
  <meta name="twitter:description" content={LANDING_DESCRIPTION} />
  <meta name="twitter:image" content={absoluteUrl(OG_IMAGE_PATH)} />

  <!-- eslint-disable-next-line svelte/no-at-html-tags -- JSON.stringify output from this module, not user input -->
  {@html `<script type="application/ld+json">${landingJsonLd()}<` + '/script>'}
</svelte:head>

<section class="grid items-center gap-10 py-10 sm:py-16 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
  <div>
    <p class="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.18em] uppercase">
      {$LL.landing.eyebrow()}
    </p>
    <h1 class="font-heading m-0 text-4xl leading-[1.05] font-semibold tracking-tight sm:text-5xl">
      {$LL.landing.title()}
    </h1>
    <p class="text-muted-foreground mt-5 mb-0 max-w-prose text-base leading-relaxed">
      {$LL.landing.subtitle()}
    </p>
    <div class="mt-7 flex flex-wrap items-center gap-3">
      <Button onclick={openLogin}>{$LL.landing.signIn()}</Button>
      <a class={buttonVariants({ variant: 'outline' })} href={REPO_URL} rel="noopener">{$LL.landing.github()}</a>
    </div>
    <p class="text-muted-foreground mt-4 mb-0 text-sm">{$LL.landing.forges()}</p>
  </div>

  <WinnowLedger />
</section>

<section class="border-border border-t pt-10 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.flowTitle()}</h2>
  <ol class="mt-6 grid list-none gap-x-8 gap-y-7 p-0 sm:grid-cols-2 lg:grid-cols-4">
    {#each flow as s, i (s.title)}
      <li>
        <span class="text-muted-foreground font-mono text-xs tabular-nums">{i + 1}</span>
        <h3 class="mt-1.5 mb-0 text-sm font-semibold">{s.title}</h3>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed">{s.body}</p>
      </li>
    {/each}
  </ol>
</section>

<section class="border-border mt-12 grid items-start gap-8 border-t pt-10 sm:mt-16 sm:pt-14 lg:grid-cols-2 lg:gap-14">
  <div>
    <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.roundsTitle()}</h2>
    <p class="text-muted-foreground mt-3 mb-0 max-w-prose text-sm leading-relaxed">{$LL.landing.roundsBody()}</p>
  </div>
  <ul class="round-summary">
    {#each rounds as r (r.text)}
      <li class:is-blocking={r.blocking}><strong>{r.count}</strong><span>{r.text}</span></li>
    {/each}
  </ul>
</section>

<section class="border-border mt-12 border-t pt-10 sm:mt-16 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.commandsTitle()}</h2>
  <p class="text-muted-foreground mt-3 mb-6 max-w-prose text-sm leading-relaxed">
    <CodeText text={$LL.landing.commandsBody()} />
  </p>
  <dl class="command-list">
    {#each commands as c (c.cmd)}
      <div>
        <dt>@winnowl {c.cmd}{#if c.arg}&nbsp;<span>{c.arg}</span>{/if}</dt>
        <dd>{c.body}</dd>
      </div>
    {/each}
  </dl>
</section>

<section class="border-border mt-12 border-t pt-10 sm:mt-16 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.moreTitle()}</h2>
  <div class="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
    {#each more as f (f.title)}
      <div>
        <h3 class="m-0 text-sm font-semibold">{f.title}</h3>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed"><CodeText text={f.body} /></p>
      </div>
    {/each}
  </div>
</section>

<section class="border-border mt-12 border-t pt-10 sm:mt-16 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.osTitle()}</h2>
  <p class="text-muted-foreground mt-3 mb-0 max-w-prose text-sm leading-relaxed">{$LL.landing.osBody()}</p>
  <div class="mt-6 flex flex-wrap gap-3">
    <a class={buttonVariants({ variant: 'outline' })} href={REPO_URL} rel="noopener">{$LL.landing.github()}</a>
    <a class={buttonVariants({ variant: 'ghost' })} href="/docs">{$LL.landing.docs()}</a>
  </div>
</section>

<section class="border-border mt-12 border-t pt-10 sm:mt-16 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.stepsTitle()}</h2>
  <ol class="mt-6 grid list-none gap-6 p-0 sm:grid-cols-2">
    {#each steps as s, i (s.title)}
      <li>
        <span class="text-muted-foreground font-mono text-xs tabular-nums">{i + 1}</span>
        <h3 class="mt-1.5 mb-0 text-sm font-semibold">{s.title}</h3>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed">{s.body}</p>
      </li>
    {/each}
  </ol>
  <div class="mt-8">
    <Button onclick={openLogin}>{$LL.landing.signIn()}</Button>
  </div>
</section>
