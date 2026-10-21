<script lang="ts">
  // Must stay SSR-safe: (marketing) prerenders through this layout in Node (no window/document).
  import '../app.css';
  import { initI18n } from '$lib/locale';

  let { children } = $props();

  // Must run before any $LL render; during prerender locale.ts falls back to en.
  initI18n();
</script>

{@render children()}
