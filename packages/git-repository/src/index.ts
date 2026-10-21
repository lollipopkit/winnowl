export {
  runGit,
  revParse,
  mergeBase,
  diffRange,
  diffFromMergeBase,
  readFileAtRevision,
  changedFilesBetween,
  hasCommit,
  fetchRef,
  addWorktree,
  removeWorktree,
} from './git.js';
export type { GitResult } from './git.js';

export { checkoutSubmodules, gitlinksAt, submoduleChanges, submoduleFetchUrl } from './submodules.js';
export type { SubmoduleCheckout, SubmoduleFileChange, SubmoduleOptions } from './submodules.js';

export { materialFingerprint } from './fingerprint.js';
export type { MaterialFingerprintInput } from './fingerprint.js';
