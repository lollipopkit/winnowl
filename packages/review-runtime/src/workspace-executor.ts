import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPatchToTree, collectTreeChanges } from '@reviewbot/autofix';
import { WorkspaceSourceProvider } from '@reviewbot/code-intel';
import {
  addWorktree,
  changedFilesBetween,
  checkoutSubmodules,
  fetchRef,
  gitlinksAt,
  hasCommit,
  readFileAtRevision,
  runGit,
} from '@reviewbot/git-repository';
import { lockfileEcosystem, manifestEcosystem } from '@reviewbot/knowledge';
import { codePlaneClient, type CodePlane, type CodePlaneRequest, type WorkspaceInfo } from './code-plane.js';
import { classifyNonReviewable } from './generated-files.js';
import { loadRepositorySkills } from './skills.js';
import { cloneRepository, cloneUrlWithoutCredentials, collectPatches, prepareWorkspace } from './workspace.js';

/**
 * One isolated workspace per job; nothing is shared between workspaces and nothing from the
 * repository is executed. `cloneUrl` credentials are never written to disk.
 */
export interface WorkspaceRequest {
  /** Carries a short-lived, read-only, single-repository token. */
  cloneUrl: string;
  /** Absent = the default branch head. */
  headSha?: string;
  /** Absent = tree workspace (no diff). */
  baseSha?: string;
  /** e.g. `refs/pull/7/head`, fetched when a fork PR's head is not in the clone. */
  headRef?: string;
  stackRootBranch?: string;
  depth?: number;
}

/** The head commit cannot be found in the repository (closed fork PR, force push…). Not retryable. */
export class WorkspaceHeadMissingError extends Error {
  readonly code = 'repository_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceHeadMissingError';
  }
}

export interface LocalWorkspace {
  info: WorkspaceInfo;
  gitDir: string;
  headDir: string;
  handle(req: CodePlaneRequest): Promise<unknown>;
  dispose(): Promise<void>;
}

const MANIFEST_SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'target', 'vendor', '.dart_tool', 'Pods', '.gradle', '.venv', 'venv', '__pycache__', '.next', 'out']);
const MANIFEST_MAX_DEPTH = 4;
const MANIFEST_MAX_FILES = 60;
const MANIFEST_MAX_BYTES = 256 * 1024;
const LOCKFILE_MAX_BYTES = 8 * 1024 * 1024;

export async function openLocalWorkspace(req: WorkspaceRequest, root: string): Promise<LocalWorkspace> {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'ws-'));
  const dispose = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const gitDir = await cloneRepository(req.cloneUrl, join(dir, 'repo'), req.depth ? { depth: req.depth } : {});
    const headSha = req.headSha ?? (await runGit(gitDir, ['rev-parse', 'HEAD'])).stdout.trim();
    await ensureCommit(gitDir, headSha, req);
    const headDir = join(dir, 'head');
    let info: Omit<WorkspaceInfo, 'nonReviewable' | 'skills' | 'manifestPaths'>;
    let source: WorkspaceSourceProvider;
    let readTrusted: (path: string) => Promise<string | null>;
    let readPatch: (path: string) => string | null = () => null;
    if (req.baseSha) {
      await ensureCommit(gitDir, req.baseSha, req);
      const ws = await prepareWorkspace({
        gitDir,
        baseSha: req.baseSha,
        headSha,
        headWorktreeDir: headDir,
        ...(req.stackRootBranch !== undefined ? { stackRootBranch: req.stackRootBranch } : {}),
      });
      source = ws.source;
      readTrusted = ws.readTrustedFile;
      readPatch = ws.readPatch;
      info = {
        changedFiles: ws.changedFiles,
        fileStates: ws.fileStates,
        headChangedLines: ws.headChangedLines,
        baseSha: req.baseSha,
        headSha,
        mergeBaseSha: ws.mergeBaseSha,
        trustedSha: ws.trustedSha,
      };
    } else {
      await addWorktree(gitDir, headDir, headSha);
      source = new WorkspaceSourceProvider(headDir, []);
      readTrusted = (path) => readFileAtRevision(gitDir, headSha, path);
      info = { changedFiles: [], fileStates: [], headChangedLines: {}, headSha, mergeBaseSha: null, trustedSha: headSha };
    }
    // Submodule code is not reviewed, but its changed files are listed for code here that uses them.
    const reviewable = info.changedFiles.filter((f) => f.status !== 'deleted').map((f) => f.path);
    const headLinks = await gitlinksAt(gitDir, headSha);
    const changedLinks = reviewable.filter((path) => headLinks.has(path));
    const baseline = info.mergeBaseSha ?? info.baseSha;
    const baseLinks =
      changedLinks.length > 0 && baseline
        ? await gitlinksAt(gitDir, baseline).catch(() => new Map<string, string>())
        : new Map<string, string>();
    const previous = new Map(
      changedLinks.flatMap((path) => (baseLinks.has(path) ? [[path, baseLinks.get(path)!] as const] : [])),
    );
    // Before anything reads the tree: reads, search, manifests and builds then see submodule files.
    const submodules = await checkoutSubmodules(headDir, cloneUrlWithoutCredentials(req.cloneUrl), { previous });
    const [classified, skills, manifestPaths] = await Promise.all([
      classifyNonReviewable({
        paths: reviewable.filter((path) => !headLinks.has(path)),
        headDir,
        gitDir,
        ...(info.trustedSha ? { baseSha: info.trustedSha } : {}),
      }),
      info.trustedSha ? loadRepositorySkills(gitDir, info.trustedSha) : Promise.resolve([]),
      listManifests(headDir),
    ]);
    const nonReviewable = new Map([...classified, ...changedLinks.map((path) => [path, 'submodule'] as const)]);
    const full: WorkspaceInfo = {
      ...info,
      nonReviewable: Object.fromEntries(nonReviewable),
      skills,
      manifestPaths,
      ...(submodules.length > 0 ? { submodules } : {}),
    };
    return {
      info: full,
      gitDir,
      headDir,
      dispose,
      handle: (r) => handleOp(r, { gitDir, headDir, headSha, source, readTrusted, readPatch }),
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function ensureCommit(gitDir: string, sha: string, req: WorkspaceRequest): Promise<void> {
  if (await hasCommit(gitDir, sha)) return;
  // Fork PR heads live under the provider's PR ref; a shallow clone may simply lack the commit.
  const refs = [...(req.headRef && sha === req.headSha ? [req.headRef] : []), sha];
  for (const ref of refs) {
    await fetchRef(gitDir, ref, `refs/winnowl/fetched`, req.cloneUrl).catch(() => undefined);
    if (await hasCommit(gitDir, sha)) return;
  }
  throw new WorkspaceHeadMissingError(
    `commit ${sha} is not in the repository` +
      (req.headRef ? ` and ${req.headRef} does not provide it (closed PR or deleted fork?)` : ''),
  );
}

async function handleOp(
  req: CodePlaneRequest,
  ws: {
    gitDir: string;
    headDir: string;
    headSha: string;
    source: WorkspaceSourceProvider;
    readTrusted: (path: string) => Promise<string | null>;
    readPatch: (path: string) => string | null;
  },
): Promise<unknown> {
  switch (req.op) {
    case 'readFiles': {
      const out: Record<string, string | null> = {};
      for (const p of req.paths) out[p] = await ws.source.readFile(p);
      return out;
    }
    case 'readTrustedFile':
      return ws.readTrusted(req.path);
    case 'searchCode':
      return ws.source.searchCode(req.query);
    case 'searchSymbol':
      return ws.source.searchSymbol(req.symbol);
    case 'changedFilesBetween': {
      const changed = await changedFilesBetween(ws.gitDir, req.sinceSha, ws.headSha);
      return changed ? [...changed] : null;
    }
    case 'diffSince': {
      const out: Record<string, string> = {};
      for (const path of req.paths) {
        try {
          const { stdout } = await runGit(ws.gitDir, ['diff', '--no-color', '-U3', `${req.sinceSha}..${ws.headSha}`, '--', `:(literal)${path}`]);
          if (!stdout.trim()) continue;
          out[path] =
            stdout.length > req.maxChars
              ? `${stdout.slice(0, req.maxChars)}\n… (truncated; read the file for the rest)`
              : stdout;
        } catch {
          // The old sha is gone (force push): only a piece of context is lost.
        }
      }
      return out;
    }
    case 'readPatches':
      return collectPatches(ws.readPatch, req.paths, req.maxCharsPerFile, req.maxTotalChars);
    case 'findFiles': {
      const names = new Set(req.names);
      const out: string[] = [];
      let level = [''];
      for (let depth = 0; depth <= req.maxDepth && level.length > 0 && out.length < req.max; depth++) {
        const next: string[] = [];
        for (const rel of level) {
          const entries = await readdir(join(ws.headDir, rel), { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            const path = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (!MANIFEST_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) next.push(path);
            } else if (e.isFile() && names.has(e.name) && out.length < req.max) out.push(path);
          }
        }
        level = next;
      }
      return out;
    }
    case 'applyPatch': {
      const git = (dir: string, args: string[]) => runGit(dir, args);
      await applyPatchToTree(ws.headDir, req.patch, git);
      return collectTreeChanges(ws.headDir, git);
    }
    default:
      throw new Error(`unknown code-plane op: ${(req as { op?: unknown }).op}`);
  }
}

export async function listManifests(root: string): Promise<string[]> {
  const out: string[] = [];
  let level = [''];
  for (let depth = 0; depth <= MANIFEST_MAX_DEPTH && level.length > 0 && out.length < MANIFEST_MAX_FILES; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!MANIFEST_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) next.push(path);
        } else if (e.isFile() && (manifestEcosystem(e.name) || lockfileEcosystem(e.name)) && out.length < MANIFEST_MAX_FILES) {
          const size = (await stat(join(root, path)).catch(() => null))?.size ?? Infinity;
          if (size <= (lockfileEcosystem(e.name) ? LOCKFILE_MAX_BYTES : MANIFEST_MAX_BYTES)) out.push(path);
        }
      }
    }
    level = next;
  }
  return out;
}

/** In-process transport: the same JSON round trip an agent does, so both paths behave alike. */
export function localDispatch(ws: LocalWorkspace): (req: CodePlaneRequest) => Promise<unknown> {
  return async (req) => JSON.parse(JSON.stringify((await ws.handle(JSON.parse(JSON.stringify(req)) as CodePlaneRequest)) ?? null));
}

export async function openLocalCodePlane(req: WorkspaceRequest, root: string): Promise<CodePlane> {
  const ws = await openLocalWorkspace(req, root);
  return {
    info: ws.info,
    client: codePlaneClient(localDispatch(ws)),
    location: { kind: 'local', headDir: ws.headDir, gitDir: ws.gitDir },
    dispose: () => ws.dispose(),
  };
}
