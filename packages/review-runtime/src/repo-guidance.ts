import { createHash } from 'node:crypto';
import { detectInjectionAttempt } from '@reviewbot/agent-pi';

/**
 * AGENTS.md / CLAUDE.md as review background, from the root and the changed files' ancestor dirs.
 * Untrusted repo content, defended three ways: read only from the trusted commit (a PR cannot edit
 * its own guidance), files with injection phrases are dropped, and content is fenced as data.
 */
export const GUIDANCE_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const GUIDANCE_MAX_FILES = 8;
export const GUIDANCE_MAX_FILE_CHARS = 6000;
export const GUIDANCE_MAX_TOTAL_CHARS = 16_000;
/** Each dir costs two git object reads; shallowest first. */
const GUIDANCE_MAX_DIRS = 200;

export interface RepositoryGuidance {
  path: string;
  content: string;
}

export interface GuidanceLoadResult {
  files: RepositoryGuidance[];
  /** Dropped for injection phrases; logged only. */
  rejected: { path: string; patterns: string[] }[];
}

export function guidanceDirs(changedPaths: readonly string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const path of changedPaths) {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, GUIDANCE_MAX_DIRS);
}

const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);

/** A symlink's git object holds its target path (e.g. CLAUDE.md -> AGENTS.md); not content. */
function looksLikeSymlinkTarget(content: string): boolean {
  return !content.includes('\n') && /^[\w./-]+$/.test(content.trim());
}

export async function loadRepositoryGuidance(
  readTrustedFile: (path: string) => Promise<string | null>,
  changedPaths: readonly string[],
): Promise<GuidanceLoadResult> {
  const files: RepositoryGuidance[] = [];
  const rejected: GuidanceLoadResult['rejected'] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const dir of guidanceDirs(changedPaths)) {
    for (const name of GUIDANCE_FILE_NAMES) {
      if (files.length >= GUIDANCE_MAX_FILES || total >= GUIDANCE_MAX_TOTAL_CHARS) return { files, rejected };
      const path = dir ? `${dir}/${name}` : name;
      const raw = await readTrustedFile(path).catch(() => null);
      const text = raw?.trim();
      if (!text || looksLikeSymlinkTarget(text)) continue;
      // CLAUDE.md is often a copy of AGENTS.md.
      const digest = createHash('sha256').update(text).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      const injection = detectInjectionAttempt(text);
      if (injection.suspicious) {
        rejected.push({ path, patterns: injection.patterns });
        continue;
      }
      const content = text.slice(0, Math.min(GUIDANCE_MAX_FILE_CHARS, GUIDANCE_MAX_TOTAL_CHARS - total));
      total += content.length;
      files.push({ path, content });
    }
  }
  return { files, rejected };
}

const TAG = 'repository-guidance';

/** Tag text is stripped from the content so it cannot close the fence early. */
export function renderRepositoryGuidance(files: readonly RepositoryGuidance[]): string | undefined {
  if (files.length === 0) return undefined;
  const strip = (text: string) => text.replace(new RegExp(`</?\\s*${TAG}[^>]*>`, 'gi'), '');
  return files.map((f) => `<${TAG} path="${strip(f.path)}">\n${strip(f.content)}\n</${TAG}>`).join('\n');
}
