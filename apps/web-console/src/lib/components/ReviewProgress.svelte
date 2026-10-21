<script lang="ts">
  import { api, type ReviewProgressItem } from '$lib/api';
  import { LL } from '$lib/i18n/i18n-svelte';
  import { elapsed, reviewSteps, stepCount, stepsUsable } from '$lib/review-steps';
  import { me, roleAtLeast } from '$lib/me';
  import Section from '$lib/components/Section.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Check from '@lucide/svelte/icons/check';
  import CircleStop from '@lucide/svelte/icons/circle-stop';
  import * as Table from '$lib/components/ui/table/index.js';

  const STEPS = $derived(reviewSteps($LL));

  /** Stages take minutes; polling faster only wastes requests. */
  const POLL_MS = 5_000;

  let items = $state<ReviewProgressItem[]>([]);
  let loaded = $state(false);
  let initialError = $state<string | null>(null);
  let allTenants = $state(false);
  /** Ticks every second so elapsed time advances between polls. */
  let now = $state(Date.now());
  /** Rows already asked to stop: cancellation is cooperative and takes tens of seconds, so keep the button disabled meanwhile. */
  let stopping = $state<string[]>([]);

  async function load(): Promise<void> {
    try {
      items = (await api.reviewProgress(allTenants)).items;
      initialError = null;
    } catch (error) {
      // Progress is auxiliary: on failure keep the last view instead of erroring the page.
      if (!loaded) initialError = (error as Error).message;
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    void allTenants; // refetch immediately when the all-tenants toggle changes
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  });

  /** Asks first: spent cost is billed anyway and a stop cannot be undone. */
  async function stop(it: ReviewProgressItem): Promise<void> {
    if (!confirm($LL.progress.stopConfirm({ repo: it.repository, n: it.changeNumber }))) return;
    stopping = [...stopping, it.jobId];
    try {
      await api.cancelReviewProgress(it.jobId);
    } catch {
      // Could not stop (already finished / no permission): re-enable the button.
      stopping = stopping.filter((id) => id !== it.jobId);
    }
    await load();
  }

  function ended(it: ReviewProgressItem): string | null {
    if (it.outcome === 'failed') return $LL.progress.failed();
    if (it.outcome === 'superseded') return $LL.progress.cancelled();
    if (it.finishedAt || it.outcome === 'done') return $LL.progress.finished();
    return null;
  }
</script>

<Section title={$LL.progress.title()} flush>
  {#snippet actions()}
    <!-- Operator-only cross-tenant toggle: tenant owners must not see other tenants' repository names. -->
    {#if $me?.isOperator}
      <label class="chk"><Checkbox bind:checked={allTenants} />{$LL.progress.allTenants()}</label>
    {/if}
  {/snippet}

  {#if initialError && items.length === 0}
    <ErrorText message={initialError} />
  {:else if items.length === 0}
    <EmptyState title={$LL.progress.empty()} />
  {:else}
    <Table.Root>
      <Table.Body>
        {#each items as it (it.jobId)}
          {@const done = ended(it)}
          {@const at = it.stepIndex ?? -1}
          <Table.Row class={it.finishedAt ? 'inactive' : undefined}>
            <Table.Cell class="w-64 truncate">
              <span class="font-medium">{it.repository}</span>
              <span class="text-muted-foreground"> #{it.changeNumber}</span>
              {#if it.tenantName}<span class="text-muted-foreground text-xs"> · {it.tenantName}</span>{/if}
              {#if it.sourceBranch}
                <div class="text-muted-foreground truncate text-xs">{it.targetBranch} ← {it.sourceBranch}</div>
              {/if}
            </Table.Cell>

            <Table.Cell>
              {#if done}
                <span class="text-muted-foreground text-sm">{done}</span>
              {:else if !stepsUsable(it, STEPS.length)}
                <!-- Version mismatch: show only "in progress" instead of possibly misaligned labels. -->
                <span class="text-muted-foreground text-sm">{$LL.progress.title()}</span>
              {:else}
                <!-- Steps, not a percentage: stage durations differ by an order of magnitude, so a percentage would stall. -->
                <ol class="progress-steps">
                  {#each STEPS as label, i (i)}
                    <li class:done={i < at} class:current={i === at}>
                      {#if i < at}<Check class="size-3" aria-hidden="true" />{/if}
                      <span>{label}</span>
                      {#if i === at && stepCount($LL, it)}<span class="step-note">{stepCount($LL, it)}</span>{/if}
                    </li>
                  {/each}
                </ol>
              {/if}
            </Table.Cell>

            <Table.Cell class="w-40 text-right whitespace-nowrap">
              <span class="text-sm tabular-nums">{$LL.progress.elapsed({ d: elapsed(it.startedAt, it.finishedAt, now) })}</span>
              {#if it.attempt > 1}<span class="text-muted-foreground text-xs"> · {$LL.progress.attempt({ n: it.attempt })}</span>{/if}
            </Table.Cell>

            <!-- Only for running rows. Stays "stopping" until the cooperative cancel completes. -->
            <Table.Cell class="w-24 text-right">
              {#if !it.finishedAt && ($me?.isOperator || roleAtLeast($me?.role, 'member'))}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={stopping.includes(it.jobId)}
                  onclick={() => void stop(it)}
                  aria-label={$LL.progress.stop()}
                >
                  <CircleStop class="size-3.5" aria-hidden="true" />
                  {stopping.includes(it.jobId) ? $LL.progress.stopping() : $LL.progress.stop()}
                </Button>
              {/if}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {/if}
</Section>
