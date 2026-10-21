import { describe, expect, it } from 'vitest';
import { orphanDirsToRemove } from '../src/work-dirs.js';

/*
 * After SIGKILL, head worktrees and clones stay in /tmp. Cleanup matches sandbox orphan cleanup: delete when
 * the owning worker is dead, otherwise by age. Deleting a workspace still in use would make a review read
 * empty files and mark prior blocking findings not-applicable, so these tests pin what must survive.
 */
describe('orphanDirsToRemove(工作目录孤儿回收)', () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 60 * 60_000;
  const live = new Set(['worker-alive']);

  it('归属已死 worker → 删,不看年龄(刚建的也删)', () => {
    expect(
      orphanDirsToRemove([{ name: 'winnowl-work-worker-dead-AbC123', createdAtMs: NOW }], NOW, HOUR, live),
    ).toEqual(['winnowl-work-worker-dead-AbC123']);
  });

  it('归属活着的 worker → 不删(哪怕很老)——那可能是在途 review 的工作区', () => {
    expect(
      orphanDirsToRemove([{ name: 'winnowl-git-worker-alive-XyZ999', createdAtMs: NOW - 10 * HOUR }], NOW, HOUR, live),
    ).toEqual([]);
  });

  it('本进程自己的目录不会被删(自己必在 liveOwners 里)', () => {
    const self = new Set(['worker-alive', 'worker-self']);
    expect(orphanDirsToRemove([{ name: 'winnowl-work-worker-self-Q1', createdAtMs: NOW }], NOW, HOUR, self)).toEqual([]);
  });

  it('无归属信息(旧格式)→ 只按年龄,且未到阈值不删', () => {
    const old = { name: 'winnowl-work-AbC123', createdAtMs: NOW - 2 * HOUR };
    const fresh = { name: 'winnowl-git-XyZ999', createdAtMs: NOW - 10_000 };
    expect(orphanDirsToRemove([old, fresh], NOW, HOUR, live)).toEqual(['winnowl-work-AbC123']);
  });

  it('无归属且年龄判不出 → 不删(宁可留垃圾,不误删在途工作区)', () => {
    expect(orphanDirsToRemove([{ name: 'winnowl-work-AbC123', createdAtMs: Number.NaN }], NOW, HOUR, live)).toEqual([]);
  });

  it('前缀不匹配的目录一概不碰(/tmp 里还有别人的东西)', () => {
    const others = [
      { name: 'winnowl-secrets', createdAtMs: NOW - 10 * HOUR },
      { name: 'tmp.XXXX', createdAtMs: NOW - 10 * HOUR },
      { name: 'rvb-engine-abc', createdAtMs: NOW - 10 * HOUR },
    ];
    expect(orphanDirsToRemove(others, NOW, HOUR, live)).toEqual([]);
  });
});
