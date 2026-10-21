/** @reviewbot/finding-lifecycle: finding persistence, semantic fingerprints and cross-revision state. */

export { semanticFingerprint, weakFingerprint } from './fingerprint.js';
export type { FingerprintInput } from './fingerprint.js';

export type { FindingLifecycle } from './reconcile.js';

export {
  ACTIVE_LIFECYCLES,
  upsertFinding,
  recordOccurrence,
  loadActiveFindings,
  loadChangeRequestBlockingFindings,
  loadChangeRequestActiveFinding,
  loadFindingsForFix,
  setFindingLifecycle,
  setOccurrenceBlocking,
  dismissFindingForChangeRequest,
  undismissFinding,
  loadDismissedFindingIds,
  loadDismissedFindings,
} from './store.js';
export type { DismissedFinding } from './store.js';
export type {
  UpsertFindingInput,
  RecordOccurrenceInput,
  ActiveFinding,
  ActiveBlockingFinding,
  ChangeRequestBlockingFinding,
  FindingFixContext,
} from './store.js';
