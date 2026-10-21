<script lang="ts">
  import { api, type ReviewProgressItem } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { elapsed, reviewSteps, stepCount, stepsUsable } from '$lib/review-steps';
  import { Button } from '$lib/components/ui/button/index.js';
  import CircleStop from '@lucide/svelte/icons/circle-stop';

  let { item, now, canStop, onchange }: { item: ReviewProgressItem; now: number; canStop: boolean; onchange: () => void } =
    $props();

  let asking = $state(false);
  let stopping = $state(false);
  const labels = $derived(reviewSteps($LL));
  const usable = $derived(stepsUsable(item, labels.length));
  const detail = $derived(
    [usable ? labels[item.stepIndex!] : null, stepCount($LL, item)].filter(Boolean).join(' · '),
  );

  async function stop(): Promise<void> {
    stopping = true;
    try {
      await api.cancelReviewProgress(item.jobId);
    } catch {
      stopping = false;
    }
    asking = false;
    onchange();
  }
</script>

<div class="run-card">
  <div class="run-head">
    <div class="run-title">
      <span class="run-ref">{item.repository} #{item.changeNumber}</span>
      {#if item.sourceBranch}<span class="run-sub">{item.sourceBranch} → {item.targetBranch}</span>{/if}
    </div>
    <span class="run-sub">{$LL.progress.elapsed({ d: elapsed(item.startedAt, item.finishedAt, now) })}</span>
    {#if canStop}
      {#if asking}
        <Button size="sm" variant="destructive" disabled={stopping} onclick={stop}>{$LL.progress.stop()}</Button>
        <Button size="sm" variant="ghost" onclick={() => (asking = false)}>{$LL.common.cancel()}</Button>
      {:else}
        <Button size="sm" variant="ghost" disabled={stopping} onclick={() => (asking = true)}>
          <CircleStop class="size-4" />{stopping ? $LL.progress.stopping() : $LL.progress.stop()}
        </Button>
      {/if}
    {/if}
  </div>
  {#if usable}
    <div class="run-steps">
      {#each labels as label, i (i)}
        <div class={['run-step', i < item.stepIndex! && 'done', i === item.stepIndex && 'now']}>
          <span class="run-bar"></span>
          <span>{label}</span>
        </div>
      {/each}
    </div>
  {/if}
  {#if asking}
    <span class="run-sub">{$LL.progress.stopConfirm({ repo: item.repository, n: item.changeNumber })}</span>
  {:else if detail}
    <span class="run-sub">{detail}</span>
  {/if}
</div>
