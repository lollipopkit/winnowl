<script lang="ts">
  import { LL } from '$lib/i18n/i18n-svelte';
  import * as Alert from '$lib/components/ui/alert/index.js';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';

  let { message }: { message: string } = $props();
</script>

<Alert.Root variant="destructive" class="mb-4">
  <CircleAlert />
  <Alert.Description>{$LL.common.error({ message })}</Alert.Description>
</Alert.Root>
