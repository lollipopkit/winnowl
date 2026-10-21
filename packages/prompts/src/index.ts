import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Prompt digests are part of the material fingerprint. */

const here = dirname(fileURLToPath(import.meta.url));
/** src and dist sit at the same depth, so this resolves from both. */
export const PROMPTS_DIR = resolve(here, '../../../prompts');

export type PromptRole = 'mapper' | 'reviewer' | 'synthesizer' | 'verifier' | 'refuter';

export interface PromptBundle {
  role: string;
  system: string;
  task: string;
  version: number;
  digest: string;
}

export async function loadPromptBundle(role: string, dir: string = PROMPTS_DIR): Promise<PromptBundle> {
  const base = resolve(dir, role);
  const system = await readFile(resolve(base, 'system.md'), 'utf8');
  const task = await readFile(resolve(base, 'task.md'), 'utf8');
  const versionRaw = await readFile(resolve(base, 'version.json'), 'utf8');
  const version = (JSON.parse(versionRaw) as { version: number }).version;
  const digest = createHash('sha256')
    .update(`${system}\0${task}\0${versionRaw}`, 'utf8')
    .digest('hex');
  return { role, system, task, version, digest };
}

export async function loadPromptBundles(
  roles: string[],
  dir: string = PROMPTS_DIR,
): Promise<Record<string, PromptBundle>> {
  const out: Record<string, PromptBundle> = {};
  for (const role of roles) {
    out[role] = await loadPromptBundle(role, dir);
  }
  return out;
}

export function promptBundleDigest(bundles: PromptBundle[]): string {
  const h = createHash('sha256');
  for (const b of [...bundles].sort((a, z) => (a.role < z.role ? -1 : 1))) {
    h.update(`${b.role}:${b.digest}\0`);
  }
  return h.digest('hex');
}

/**
 * Review checklist. Built-in ones live in `prompts/skills/*.md`; repository ones are read from the
 * base branch. The system prompt only lists name + description; bodies load via `load_skill`.
 */
export interface ReviewSkill {
  name: string;
  description: string;
  body: string;
  source: 'platform' | 'repository';
}

/** Also the file name and the only key `load_skill` accepts. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SKILL_MAX_CHARS = 8000;

/** Parses frontmatter + body; returns null on a bad shape or invalid name. */
export function parseSkill(text: string, fallbackName: string, source: ReviewSkill['source']): ReviewSkill | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  const meta = new Map<string, string>();
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta.set(kv[1]!, kv[2]!.trim());
  }
  const name = meta.get('name') ?? fallbackName;
  if (!SKILL_NAME.test(name)) return null;
  const body = (m ? m[2]! : text).trim().slice(0, SKILL_MAX_CHARS);
  if (!body) return null;
  return { name, description: (meta.get('description') ?? '').slice(0, 200), body, source };
}

/** Sorted by name so the system prompt prefix stays stable (prompt cache). */
export async function loadPlatformSkills(dir: string = resolve(PROMPTS_DIR, 'skills')): Promise<ReviewSkill[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const skills: ReviewSkill[] = [];
  for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
    const skill = parseSkill(await readFile(resolve(dir, file), 'utf8'), file.slice(0, -3), 'platform');
    if (skill) skills.push(skill);
  }
  return skills;
}
