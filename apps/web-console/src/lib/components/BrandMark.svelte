<script lang="ts">
  /** Inherits `currentColor`; eyes and squares are holes showing the background (see brand.ts). */
  import { OWL_ASPECT, OWL_PATHS, OWL_VIEWBOX } from '$lib/brand';

  let { size = 20 }: { size?: number } = $props();

  // Explicit width from the viewBox ratio: with height only, the SVG stretches to the parent width in flex layouts.
  const width = $derived(size / OWL_ASPECT);
</script>

<svg viewBox={OWL_VIEWBOX} width={width} height={size} fill="currentColor" aria-hidden="true">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- paths come from brand.ts, not user input -->
  {@html OWL_PATHS}
</svg>
