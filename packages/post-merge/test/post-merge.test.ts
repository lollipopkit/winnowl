import { describe, expect, it } from 'vitest';
import { planPostMergeActions, type PostMergeActionKind } from '../src/index.js';

const ALL: PostMergeActionKind[] = [
  'update-docs',
  'generate-changelog',
  'refresh-generated-client',
  'create-follow-up-issue',
  'run-migration-validation',
  'notify-related-repo',
  'create-follow-up-cr',
];

describe('planPostMergeActions', () => {
  it('非默认分支 merge → 不触发', () => {
    const p = planPostMergeActions({ mergedToDefaultBranch: false, changedFiles: [], enabledActions: ALL });
    expect(p.actions).toHaveLength(0);
    expect(p.reusesReviewSession).toBe(false);
  });

  it('代码修改动作标注经新 CR 交付', () => {
    const p = planPostMergeActions({ mergedToDefaultBranch: true, changedFiles: ['docs/x.md'], enabledActions: ['update-docs', 'create-follow-up-issue'] });
    expect(p.actions.find((a) => a.kind === 'update-docs')?.deliversViaNewChangeRequest).toBe(true);
    expect(p.actions.find((a) => a.kind === 'create-follow-up-issue')?.deliversViaNewChangeRequest).toBe(false);
  });

  it('相关性:契约面变化才刷新客户端;迁移变化才校验', () => {
    const noContract = planPostMergeActions({ mergedToDefaultBranch: true, changedFiles: ['src/a.ts'], enabledActions: ['refresh-generated-client', 'run-migration-validation'] });
    expect(noContract.actions).toHaveLength(0);
    expect(noContract.skipped.map((s) => s.kind).sort()).toEqual(['refresh-generated-client', 'run-migration-validation']);

    const withContract = planPostMergeActions({ mergedToDefaultBranch: true, changedFiles: ['api/user.proto', 'migrations/0001.sql'], enabledActions: ['refresh-generated-client', 'run-migration-validation'] });
    expect(withContract.actions.map((a) => a.kind).sort()).toEqual(['refresh-generated-client', 'run-migration-validation']);
  });

  it('reasonCode 类型化(§37 发布端本地化,不预渲染中文串)', () => {
    const p = planPostMergeActions({
      mergedToDefaultBranch: true,
      changedFiles: ['api/user.proto', 'migrations/0001.sql', 'docs/x.md'],
      enabledActions: ['refresh-generated-client', 'run-migration-validation', 'update-docs'],
    });
    const codeByKind = Object.fromEntries(p.actions.map((a) => [a.kind, a.reasonCode]));
    expect(codeByKind['refresh-generated-client']).toBe('contract-change');
    expect(codeByKind['run-migration-validation']).toBe('migration-change');
    expect(codeByKind['update-docs']).toBe('enabled');
  });
});
