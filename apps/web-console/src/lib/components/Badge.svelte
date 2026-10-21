<script lang="ts">
  import { Badge as Ui, type BadgeVariant } from '$lib/components/ui/badge';
  import { toneFor, type BadgeTone } from '$lib/theme';

  /** Maps semantic tone (inferred from the value when omitted, see `$lib/theme`) to shadcn variants. */
  let { value, tone }: { value: string; tone?: BadgeTone } = $props();

  // warn uses outline: the nova preset has no warning variant, and a custom colour would leave the theme.
  const VARIANT: Record<BadgeTone, BadgeVariant> = {
    neutral: 'secondary',
    accent: 'default',
    ok: 'ghost',
    warn: 'outline',
    danger: 'destructive',
  };

  const variant = $derived(VARIANT[tone ?? toneFor(value)]);
</script>

<Ui {variant}>{value}</Ui>
