<script lang="ts" module>
  export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  /**
   * Thin wrapper over the bits-ui `Select` taking `options` + `value`.
   * Unlike native select, `onchange` receives the value itself: bits-ui dispatches no native change event.
   */
  import * as Select from '$lib/components/ui/select/index.js';

  let {
    value = $bindable(''),
    options,
    placeholder = '',
    disabled = false,
    id,
    onchange,
    class: className,
  }: {
    value?: string;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    onchange?: (value: string) => void;
    class?: string;
  } = $props();

  // Falls back to the placeholder when the value is not an option (e.g. '' for "all").
  const label = $derived(options.find((o) => o.value === value)?.label ?? placeholder);
</script>

<Select.Root type="single" bind:value {disabled} onValueChange={(v) => onchange?.(v)}>
  <Select.Trigger {id} class={className}>{label}</Select.Trigger>
  <Select.Content>
    {#each options as o (o.value)}
      <Select.Item value={o.value} label={o.label} disabled={o.disabled} />
    {/each}
  </Select.Content>
</Select.Root>
