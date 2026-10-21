<script lang="ts">
  /**
   * Dialog with a form; the caller provides the trigger (`trigger` snippet gets `open`). `AddDialog` specializes it.
   * Submit failures keep the dialog open and show the error inside it, where the page banner would be hidden.
   */
  import type { Snippet } from 'svelte';
  import { LL } from '$lib/i18n/i18n-svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import ErrorText from './ErrorText.svelte';

  let {
    title,
    description,
    submitLabel,
    canSubmit = true,
    onopen,
    onsubmit,
    trigger,
    children,
  }: {
    title: string;
    description?: string;
    submitLabel: string;
    /** Submit is disabled while false. */
    canSubmit?: boolean;
    /** Called before each open (e.g. to prefill from the current row). */
    onopen?: () => void;
    /** A throw counts as failure: the dialog stays open and shows the error. */
    onsubmit: () => Promise<unknown>;
    trigger: Snippet<[() => void]>;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function show(): void {
    error = null;
    onopen?.();
    open = true;
  }

  async function submit(): Promise<void> {
    busy = true;
    error = null;
    try {
      await onsubmit();
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{@render trigger(show)}

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
    </Dialog.Header>
    <div class="grid gap-3">{@render children()}</div>
    {#if error}<ErrorText message={error} />{/if}
    <Dialog.Footer>
      <Button variant="outline" disabled={busy} onclick={() => (open = false)}>{$LL.common.cancel()}</Button>
      <Button disabled={busy || !canSubmit} onclick={submit}>{submitLabel}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
