<script lang="ts">
  import { LL } from '$lib/i18n/i18n-svelte';
  import { openLogin } from '$lib/login-dialog.svelte.js';
  import {
    LANDING_DESCRIPTION,
    LANDING_TITLE,
    OG_IMAGE_PATH,
    SITE_NAME,
    absoluteUrl,
    landingJsonLd,
  } from '$lib/seo';

  import { Button } from '$lib/components/ui/button/index.js';

  const features = $derived([
    { title: $LL.landing.verifyTitle(), body: $LL.landing.verifyBody() },
    { title: $LL.landing.selfHostTitle(), body: $LL.landing.selfHostBody() },
    { title: $LL.landing.commandsTitle(), body: $LL.landing.commandsBody() },
    { title: $LL.landing.gateTitle(), body: $LL.landing.gateBody() },
  ]);

  // Steps are numbered because their order matters (install before review); features are not.
  const steps = $derived([
    { title: $LL.landing.step1Title(), body: $LL.landing.step1Body() },
    { title: $LL.landing.step2Title(), body: $LL.landing.step2Body() },
  ]);

  const dropped = $derived([$LL.landing.demoDropped1(), $LL.landing.demoDropped2(), $LL.landing.demoDropped3()]);
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

<section class="grid items-center gap-10 py-10 sm:py-16 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
  <div>
    <p class="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.18em] uppercase">
      {$LL.landing.eyebrow()}
    </p>
    <h1 class="font-heading m-0 text-3xl leading-[1.1] font-semibold tracking-tight sm:text-4xl">
      {$LL.landing.title()}
    </h1>
    <p class="text-muted-foreground mt-4 mb-0 max-w-prose text-base leading-relaxed">
      {$LL.landing.subtitle()}
    </p>
    <div class="mt-7 flex flex-wrap items-center gap-3">
      <Button onclick={openLogin}>{$LL.landing.signIn()}</Button>
      <span class="text-muted-foreground text-sm">{$LL.landing.forgesTitle()}</span>
    </div>
  </div>

  <figure class="border-border bg-card m-0 rounded-xl border p-5 sm:p-6">
    <figcaption class="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
      {$LL.landing.demoCandidates()}
    </figcaption>
    <ul class="m-0 grid list-none gap-1.5 p-0">
      {#each dropped as claim (claim)}
        <li class="text-muted-foreground/60 truncate text-sm line-through">{claim}</li>
      {/each}
    </ul>

    <div class="my-5 flex items-center gap-3" aria-hidden="true">
      <span class="border-border flex-1 border-t border-dashed"></span>
      <span class="text-muted-foreground text-[10px] font-semibold tracking-[0.2em] uppercase">winnow</span>
      <span class="border-border flex-1 border-t border-dashed"></span>
    </div>

    <figcaption class="text-muted-foreground mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
      {$LL.landing.demoKept()}
    </figcaption>
    <ul class="m-0 grid list-none gap-2.5 p-0">
      <li class="border-border bg-background rounded-lg border p-3">
        <div class="flex items-start gap-2">
          <span class="bg-chart-1 mt-1.5 size-1.5 shrink-0 rounded-full" aria-hidden="true"></span>
          <p class="m-0 text-sm leading-snug">{$LL.landing.demoKeptClaim()}</p>
        </div>
        <code class="text-muted-foreground mt-2 block text-xs">{$LL.landing.demoKeptLoc()}</code>
      </li>
    </ul>
    <p class="text-muted-foreground/70 mt-4 mb-0 text-[11px]">{$LL.landing.demoNote()}</p>
  </figure>
</section>

<section class="border-border border-t pt-10 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.featuresTitle()}</h2>
  <div class="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2">
    {#each features as f (f.title)}
      <div>
        <h3 class="m-0 text-sm font-semibold">{f.title}</h3>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed">{f.body}</p>
      </div>
    {/each}
  </div>
</section>

<section class="border-border mt-12 border-t pt-10 sm:mt-16 sm:pt-14">
  <h2 class="font-heading m-0 text-xl font-semibold tracking-tight">{$LL.landing.stepsTitle()}</h2>
  <ol class="mt-6 grid list-none gap-6 p-0 sm:grid-cols-2">
    {#each steps as s, i (s.title)}
      <li>
        <span class="text-muted-foreground/60 font-heading text-sm font-semibold tabular-nums">
          {String(i + 1).padStart(2, '0')}
        </span>
        <h3 class="mt-1.5 mb-0 text-sm font-semibold">{s.title}</h3>
        <p class="text-muted-foreground mt-1.5 mb-0 text-sm leading-relaxed">{s.body}</p>
      </li>
    {/each}
  </ol>
  <div class="mt-8">
    <Button onclick={openLogin}>{$LL.landing.signIn()}</Button>
  </div>
</section>
