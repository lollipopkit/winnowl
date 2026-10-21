import type { InboxItem } from './api';
import type { Locales, TranslationFunctions } from './i18n/i18n-types';
import { formatRelativeTime } from './format';
import Wrench from '@lucide/svelte/icons/wrench';
import ListChecks from '@lucide/svelte/icons/list-checks';
import Lightbulb from '@lucide/svelte/icons/lightbulb';
import Network from '@lucide/svelte/icons/network';
import UserCheck from '@lucide/svelte/icons/user-check';
import Bell from '@lucide/svelte/icons/bell';
import NotebookPen from '@lucide/svelte/icons/notebook-pen';

export const INBOX_ICONS = { plan: Wrench, rule: ListChecks, memory: NotebookPen, recommendation: Lightbulb, dependency: Network, installation: UserCheck, notification: Bell };

function ref(i: InboxItem): string {
  const p = i.plan!;
  const repo = p.repository?.split('/').pop() ?? '';
  return p.changeNumber !== null ? `${repo} #${p.changeNumber}` : repo;
}

export function inboxTitle(LL: TranslationFunctions, i: InboxItem): string {
  switch (i.kind) {
    case 'plan': {
      const types = i.plan!.actions.map((a) => a.type);
      if (types.length === 1 && types[0] === 'create-stacked-pr') return LL.inbox.planFix({ ref: ref(i) });
      if (types.length === 1 && types[0] === 'create-issue') return LL.inbox.planIssue({ ref: ref(i) });
      if (types.length === 1 && types[0] === 'reply') return LL.inbox.planReply({ ref: ref(i) });
      return LL.inbox.planOther({ count: types.length, ref: ref(i) });
    }
    case 'rule':
      return i.rule!.instruction;
    case 'memory':
      return i.memory!.summary;
    case 'recommendation':
      return i.recommendation!.instruction;
    case 'dependency':
      return LL.inbox.dependencyTitle({ source: i.dependency!.source, target: i.dependency!.target });
    case 'installation':
      return LL.inbox.installationTitle({ account: i.installation!.accountLogin, provider: i.installation!.provider });
    case 'notification':
      return i.notification!.title;
  }
}

export function inboxDescription(i: InboxItem): string {
  switch (i.kind) {
    case 'plan':
      return i.plan!.actions.map((a) => a.description).join(' ');
    case 'rule':
      return i.rule!.rationale;
    case 'memory':
      return i.memory!.body;
    case 'recommendation':
      return i.recommendation!.rationale;
    case 'dependency':
      return i.dependency!.rationale ?? '';
    case 'notification':
      return i.notification!.body;
    default:
      return '';
  }
}

export function inboxMeta(LL: TranslationFunctions, loc: Locales, i: InboxItem): string {
  const age = formatRelativeTime(i.createdAt, loc);
  switch (i.kind) {
    case 'plan':
      return `${LL.inbox.planMeta({ time: formatRelativeTime(i.plan!.expiresAt, loc), perms: i.plan!.requiredPermissions.join(', ') || '—' })} · ${age}`;
    case 'rule': {
      const r = i.rule!;
      const scope =
        r.broadness === 'organization'
          ? LL.inbox.ruleScopeOrg()
          : r.broadness === 'user'
            ? LL.inbox.ruleScopeUser()
            : LL.inbox.ruleScopeRepo({ repo: r.repository ?? '' });
      return `${LL.inbox.ruleMeta({ who: r.proposedBy, scope })} · ${age}`;
    }
    case 'memory':
      return `${LL.inbox.memoryMeta({ who: i.memory!.proposedBy ?? '—', repo: i.memory!.repository ?? '' })} · ${age}`;
    case 'recommendation':
      return `${LL.inbox.recommendationMeta()} · ${age}`;
    case 'dependency':
      return `${LL.inbox.dependencyMeta({ kind: i.dependency!.kind, source: i.dependency!.source, target: i.dependency!.target })} · ${age}`;
    case 'installation':
      return `${LL.inbox.installationMeta({ who: i.installation!.installerLogin })} · ${age}`;
    case 'notification':
      return `${noticeKind(LL, i.notification!.kind)} · ${age}`;
  }
}

function noticeKind(LL: TranslationFunctions, kind: string): string {
  const labels: Record<string, () => string> = {
    'security-finding': () => LL.notifications.kindSecurity(),
    'quota-warning': () => LL.notifications.kindQuota(),
    'cross-tenant-contract-change': () => LL.notifications.kindContract(),
    'review-completed': () => LL.notifications.kindReview(),
  };
  return (labels[kind] ?? (() => LL.notifications.kindOther()))();
}
