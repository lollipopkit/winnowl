import { createHash } from 'node:crypto';
import { readFileAtRevision, runGit } from '@reviewbot/git-repository';
import { parseSkill, SKILL_NAME, type ReviewSkill } from '@reviewbot/prompts';

export const REPOSITORY_SKILLS_DIR = '.winnowl/skills';
const REPOSITORY_SKILLS_MAX = 20;

/** Read from base only, so a PR cannot instruct the agent reviewing it; still treated as untrusted data. */
export async function loadRepositorySkills(gitDir: string, baseSha: string): Promise<ReviewSkill[]> {
  let listing: string;
  try {
    ({ stdout: listing } = await runGit(gitDir, ['ls-tree', '-z', '--name-only', baseSha, '--', `${REPOSITORY_SKILLS_DIR}/`]));
  } catch {
    return [];
  }
  const paths = listing
    .split('\0')
    .filter((p) => p.startsWith(`${REPOSITORY_SKILLS_DIR}/`) && p.endsWith('.md') && !p.slice(REPOSITORY_SKILLS_DIR.length + 1).includes('/'))
    .sort()
    .slice(0, REPOSITORY_SKILLS_MAX);
  const skills: ReviewSkill[] = [];
  for (const path of paths) {
    const text = await readFileAtRevision(gitDir, baseSha, path).catch(() => null);
    if (!text) continue;
    const fileName = path.slice(REPOSITORY_SKILLS_DIR.length + 1, -3).toLowerCase();
    const skill = parseSkill(text, fileName, 'repository');
    if (skill) skills.push(skill);
  }
  return skills;
}

/** A repo skill cannot replace a platform one: on a name clash it becomes `repo-<name>`, or is dropped. */
export function mergeSkills(platform: readonly ReviewSkill[], repository: readonly ReviewSkill[]): ReviewSkill[] {
  const taken = new Set(platform.map((s) => s.name));
  const merged = [...platform];
  for (const skill of repository) {
    const name = taken.has(skill.name) ? `repo-${skill.name}` : skill.name;
    if (!SKILL_NAME.test(name) || taken.has(name)) continue;
    taken.add(name);
    merged.push({ ...skill, name });
  }
  return merged;
}

/** Contract-digest line: editing a skill invalidates prior coverage. */
export function skillStandardLine(skill: ReviewSkill): string {
  return `skill:${skill.source}:${skill.name}:${createHash('sha256').update(skill.body, 'utf8').digest('hex')}`;
}
