<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import CommandLog from '$lib/components/CommandLog.svelte';
  import ErrorText from '$lib/components/ErrorText.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { LL, locale } from '$lib/i18n/i18n-svelte';
  import { api, type InboxItem, type InboxKind } from '$lib/api';
  import { formatRelativeTime } from '$lib/format';
  import { notifyInboxChanged } from '$lib/inbox';
  import { INBOX_ICONS, inboxDescription, inboxMeta, inboxTitle } from '$lib/inbox-text';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleMinus from '@lucide/svelte/icons/circle-minus';
  import Inbox from '@lucide/svelte/icons/inbox';

  type View = 'pending' | 'done';
  const view = $derived<View>($page.url.searchParams.get('view') === 'done' ? 'done' : 'pending');

  let items = $state<InboxItem[] | null>(null);
  let error = $state('');
  let busy = $state<string | null>(null);

  $effect(() => {
    const v = view;
    items = null;
    error = '';
    api
      .inbox(v)
      .then((r) => (items = r.items))
      .catch((e: Error) => (error = e.message));
  });

  const GROUPS: { key: string; kinds: InboxKind[]; title: () => string }[] = [
    { key: 'plan', kinds: ['plan'], title: () => $LL.inbox.groupPlan() },
    { key: 'rule', kinds: ['rule', 'recommendation'], title: () => $LL.inbox.groupRule() },
    { key: 'memory', kinds: ['memory'], title: () => $LL.inbox.groupMemory() },
    { key: 'dependency', kinds: ['dependency'], title: () => $LL.inbox.groupDependency() },
    { key: 'installation', kinds: ['installation'], title: () => $LL.inbox.groupInstallation() },
    { key: 'notification', kinds: ['notification'], title: () => $LL.inbox.groupNotification() },
  ];
  const groups = $derived(
    GROUPS.map((g) => ({ ...g, items: (items ?? []).filter((i) => g.kinds.includes(i.kind)) })).filter(
      (g) => g.items.length > 0,
    ),
  );

  const OUTCOME: Record<string, () => string> = {
    approved: () => $LL.inbox.outApproved(),
    declined: () => $LL.inbox.outDeclined(),
    rejected: () => $LL.inbox.outRejected(),
    expired: () => $LL.inbox.outExpired(),
    executed: () => $LL.inbox.outExecuted(),
    failed: () => $LL.inbox.outFailed(),
    executing: () => $LL.inbox.outExecuting(),
    accepted: () => $LL.inbox.outAccepted(),
    read: () => $LL.inbox.outRead(),
    active: () => $LL.inbox.outActive(),
  };
  const positive = (outcome: string): boolean => ['approved', 'executed', 'executing', 'accepted', 'active'].includes(outcome);

  async function act(i: InboxItem, ok: boolean): Promise<void> {
    busy = i.id;
    try {
      switch (i.kind) {
        case 'plan':
          if (ok) await api.confirmActionPlan(i.sourceId, i.plan!.conversationId);
          else await api.declineActionPlan(i.sourceId);
          toast.success(ok ? $LL.inbox.toastPlanApproved() : $LL.inbox.toastPlanDeclined());
          break;
        case 'rule':
          await api.learningAction(i.sourceId, ok ? 'approve' : 'reject');
          break;
        case 'memory':
          await api.memoryAction(i.sourceId, ok ? 'approve' : 'reject');
          break;
        case 'recommendation':
          await (ok ? api.adoptGlobalLearning(i.sourceId) : api.declineGlobalLearning(i.sourceId));
          break;
        case 'dependency':
          await api.transitionRelationship(i.sourceId, ok ? 'approve' : 'reject');
          break;
        case 'installation':
          await api.decidePendingInstallation(i.sourceId, ok ? 'approve' : 'reject');
          break;
        case 'notification':
          await api.markNotificationRead(i.sourceId);
          break;
      }
      if (i.kind !== 'plan') toast.success($LL.inbox.toastDone());
      items = (items ?? []).filter((x) => x.id !== i.id);
      notifyInboxChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      busy = null;
    }
  }

  async function markAllRead(): Promise<void> {
    try {
      await api.markAllNotificationsRead();
      items = (items ?? []).filter((x) => x.kind !== 'notification');
      notifyInboxChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const labels = (i: InboxItem): { yes: string; no?: string } => {
    switch (i.kind) {
      case 'plan':
        return { yes: $LL.inbox.approveRun(), no: $LL.inbox.decline() };
      case 'recommendation':
        return { yes: $LL.inbox.adopt(), no: $LL.inbox.notUse() };
      case 'notification':
        return { yes: $LL.inbox.markRead() };
      default:
        return { yes: $LL.inbox.approve(), no: $LL.inbox.reject() };
    }
  };

  const pendingCount = $derived(view === 'pending' ? (items?.length ?? 0) : 0);
</script>

<PageHeader title={$LL.nav.inbox()}>
  {#snippet actions()}
    <Tabs.Root value={view} onValueChange={(v) => goto(v === 'done' ? '?view=done' : '?', { replaceState: true, keepFocus: true })}>
      <Tabs.List>
        <Tabs.Trigger value="pending">{$LL.inbox.pending()}{pendingCount ? ` · ${pendingCount}` : ''}</Tabs.Trigger>
        <Tabs.Trigger value="done">{$LL.inbox.done()}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  {/snippet}
</PageHeader>

<div class="inbox">
  <p class="text-muted-foreground m-0 text-sm">{$LL.inbox.intro()}</p>

  {#if error}
    <ErrorText message={error} />
  {:else if items === null}
    <p class="text-muted-foreground text-sm">{$LL.common.loading()}</p>
  {:else if groups.length === 0}
    <div class="inbox-empty">
      <Inbox class="size-10" />
      <span>{$LL.inbox.empty()}</span>
    </div>
  {:else}
    {#each groups as g (g.key)}
      <section class="inbox-group">
        <div class="inbox-group-head">
          <span class="eyebrow">{g.title()} · {g.items.length}</span>
          {#if g.key === 'notification' && view === 'pending'}
            <button type="button" class="inbox-link" onclick={markAllRead}>{$LL.inbox.markAllRead()}</button>
          {/if}
        </div>
        {#each g.items as i (i.id)}
          {@const Icon = INBOX_ICONS[i.kind]}
          <article class="inbox-card">
            <div class="inbox-card-main">
              <span class={['inbox-icon', i.kind === 'plan' && 'strong', i.kind === 'notification' && 'quiet']}><Icon class="size-4" /></span>
              <div class="inbox-text">
                <span class="inbox-title">{inboxTitle($LL, i)}</span>
                {#if inboxDescription(i)}<span class="inbox-desc">{inboxDescription(i)}</span>{/if}
                <span class="inbox-meta">{inboxMeta($LL, $locale, i)}</span>
              </div>
            </div>
            <div class="inbox-card-foot">
              {#if i.kind === 'plan'}<CommandLog planId={i.sourceId} />{/if}
              {#if i.decided}
                <span class={['inbox-outcome', positive(i.decided.outcome) && 'ok']}>
                  {#if positive(i.decided.outcome)}<CircleCheck class="size-4" />{:else}<CircleMinus class="size-4" />{/if}
                  {(OUTCOME[i.decided.outcome] ?? (() => i.decided!.outcome))()} · {formatRelativeTime(i.decided.at, $locale)}
                </span>
              {:else}
                <div class="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy === i.id} onclick={() => act(i, true)}>{labels(i).yes}</Button>
                  {#if labels(i).no}
                    <Button size="sm" variant="outline" disabled={busy === i.id} onclick={() => act(i, false)}>{labels(i).no}</Button>
                  {/if}
                  {#if i.notification?.link}
                    <Button size="sm" variant="ghost" href={i.notification.link}>{$LL.inbox.open()}</Button>
                  {/if}
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </section>
    {/each}
  {/if}
</div>
