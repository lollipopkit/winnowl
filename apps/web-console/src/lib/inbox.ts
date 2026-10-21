import { writable } from 'svelte/store';
import { api } from './api';

/** Pending inbox items for the nav badge. */
export const inboxPending = writable(0);

export function refreshInboxCount(): void {
  void api
    .inboxCount()
    .then((r) => inboxPending.set(r.pending))
    .catch(() => undefined);
}

export const notifyInboxChanged = refreshInboxCount;
