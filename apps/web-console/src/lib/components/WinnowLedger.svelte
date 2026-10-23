<script lang="ts">
  /** Landing hero: candidate findings of one review and the stage each one reached (illustrative data). */
  import { LL } from '$lib/i18n/i18n-svelte';

  type Row = { claim: string; reached: 1 | 2 | 3; reason?: string; loc?: string; tag?: string };

  const stages = $derived([
    $LL.landing.stageFound(),
    $LL.landing.stageVerified(),
    $LL.landing.stageChallenged(),
    $LL.landing.stagePosted(),
  ]);

  // `reached` is the index of the last stage a candidate got to; below 3 it was dropped there.
  const rows: Row[] = $derived([
    { claim: $LL.landing.demo1Claim(), reached: 3, loc: 'auth/refresh.ts:88', tag: $LL.landing.demoMajor() },
    { claim: $LL.landing.demo2Claim(), reached: 1, reason: $LL.landing.demo2Reason() },
    { claim: $LL.landing.demo3Claim(), reached: 2, reason: $LL.landing.demo3Reason() },
    { claim: $LL.landing.demo4Claim(), reached: 1, reason: $LL.landing.demo4Reason() },
    { claim: $LL.landing.demo5Claim(), reached: 3, loc: 'go.mod', tag: $LL.landing.demoBlocks() },
    { claim: $LL.landing.demo6Claim(), reached: 2, reason: $LL.landing.demo6Reason() },
  ]);
</script>

<figure class="winnow" aria-labelledby="winnow-caption">
  <figcaption id="winnow-caption" class="winnow-caption">{$LL.landing.demoLabel()}</figcaption>

  <div class="winnow-stages" aria-hidden="true">
    {#each stages as s (s)}<span>{s}</span>{/each}
  </div>

  <ol class="winnow-rows">
    {#each rows as r, i (r.claim)}
      <li class="winnow-row" class:is-kept={r.reached === 3} style={`--reach:${r.reached / 3};--row:${i}`}>
        <p class="winnow-claim">{r.claim}</p>
        <div class="winnow-track" aria-hidden="true">
          <span class="winnow-fill"></span>
          {#each [0, 1, 2, 3] as stop (stop)}
            <span
              class="winnow-stop"
              class:is-passed={stop <= r.reached && !(stop === r.reached && r.reached < 3)}
              class:is-drop={stop === r.reached && r.reached < 3}
              style={`--at:${stop / 3}`}
            ></span>
          {/each}
        </div>
        {#if r.reached < 3}
          <p class="winnow-reason">
            <span class="sr-only">{$LL.landing.demoDroppedAt({ stage: stages[r.reached] ?? '' })}</span>{r.reason}
          </p>
        {:else}
          <p class="winnow-posted">
            <span class="sr-only">{stages[3]}:</span>
            <span class="winnow-tag">{r.tag}</span>
            <code>{r.loc}</code>
          </p>
        {/if}
      </li>
    {/each}
  </ol>
  <p class="winnow-note">{$LL.landing.demoNote()}</p>
</figure>
