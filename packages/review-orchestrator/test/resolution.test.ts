import { describe, expect, it } from 'vitest';
import { createFauxAgent, type SourceProvider } from '@reviewbot/agent-pi';
import { reconcilePriorBlocking, type PriorBlockingFinding, type ResolutionDeps } from '../src/index.js';

// Source stub returning content by path (simulates the new head).
function sourceOf(files: Record<string, string>): SourceProvider {
  return {
    listChangedFiles: async () => Object.keys(files).map((path) => ({ path, status: 'modified' })),
    readFile: async (path: string) => files[path] ?? null,
    searchCode: async () => [],
  };
}

function deps(
  source: SourceProvider,
  faux?: ReturnType<typeof createFauxAgent>,
  maxVerify?: number,
  filesChangedSince?: ResolutionDeps['filesChangedSince'],
): ResolutionDeps {
  const f = faux ?? createFauxAgent();
  return {
    source,
    model: f.model,
    streamFn: f.streamFn,
    budget: { maxTurns: 4, maxToolCalls: 8 },
    ...(maxVerify !== undefined ? { maxVerify } : {}),
    ...(filesChangedSince ? { filesChangedSince } : {}),
  };
}

// Stub for "files changed since sinceSha"; unknown sha -> null (undecidable).
const changedSince = (bySha: Record<string, string[] | null>): ResolutionDeps['filesChangedSince'] => {
  return async (sha: string) => {
    const entry = bySha[sha];
    return entry === null || entry === undefined ? null : new Set(entry);
  };
};

const prior = (extra: Partial<PriorBlockingFinding> = {}): PriorBlockingFinding => ({
  findingId: 'F1',
  fingerprint: 'fp1',
  claim: 'getDefaults() shallow-copies; nested features leaks',
  anchorText: 'return { ...defaults };',
  path: 'src/config.js',
  lastSeenHeadSha: 'sha-prev',
  ...extra,
});

describe('reconcilePriorBlocking(增量 review 门禁对账)', () => {
  it('文件自上次报出以来一行没动 → still-present,零 LLM(不消耗 faux 响应)', async () => {
    const source = sourceOf({ 'src/config.js': 'function getDefaults() {\n  return { ...defaults };\n}\n' });
    const faux = createFauxAgent();
    faux.setResponses([]); // An unexpected LLM call errors for lack of responses.
    const r = await reconcilePriorBlocking(deps(source, faux, undefined, changedSince({ 'sha-prev': ['src/other.js'] })), [prior()]);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('still-present');
    expect(r[0]!.method).toBe('file-unchanged');
  });

  it('文件动过 → 定向 LLM 核验;LLM 判 fixed → resolved', async () => {
    const source = sourceOf({ 'src/config.js': 'function getDefaults() {\n  return structuredClone(defaults);\n}\n' });
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'now deep-clones' }))]);
    const r = await reconcilePriorBlocking(deps(source, faux, undefined, changedSince({ 'sha-prev': ['src/config.js'] })), [prior()]);
    expect(r[0]!.status).toBe('resolved');
    expect(r[0]!.method).toBe('llm-verify');
  });

  it('文件动过但 LLM 判 still-present → 保持 blocking,并带回核验理由', async () => {
    const source = sourceOf({ 'src/config.js': 'function getDefaults() {\n  return Object.assign({}, defaults);\n}\n' });
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_resolution', { status: 'still-present', reasoning: 'still shallow' }))]);
    const r = await reconcilePriorBlocking(deps(source, faux, undefined, changedSince({ 'sha-prev': ['src/config.js'] })), [prior()]);
    expect(r[0]!.status).toBe('still-present');
    expect(r[0]!.reason).toBe('still shallow');
  });

  // The anchor is a declaration line and the fix lands inside the closure body, so the anchor text is unchanged.
  // The criterion is "was the file touched", so this must reach the LLM.
  it('锚文本原样保留但文件动过 → 仍走 LLM(修复可以发生在锚点之外)', async () => {
    const source = sourceOf({ 'src/config.js': 'function getDefaults() {\n  assertFrozen(defaults);\n  return { ...defaults };\n}\n' });
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'callers now get a frozen copy' }))]);
    const r = await reconcilePriorBlocking(deps(source, faux, undefined, changedSince({ 'sha-prev': ['src/config.js'] })), [prior()]);
    expect(r[0]!.method).toBe('llm-verify');
    expect(r[0]!.status).toBe('resolved');
  });

  it('判不了「动没动过」(无 filesChangedSince / sha 不在 clone 里)→ 交 LLM,不猜', async () => {
    const source = sourceOf({ 'src/config.js': 'unchanged text\n' });
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'a' })),
      faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'b' })),
    ]);
    const noCallback = await reconcilePriorBlocking(deps(source, faux), [prior()]);
    expect(noCallback[0]!.method).toBe('llm-verify');
    const unknownSha = await reconcilePriorBlocking(deps(source, faux, undefined, changedSince({ 'sha-other': [] })), [prior()]);
    expect(unknownSha[0]!.method).toBe('llm-verify');
  });

  it('LLM 未终结(不确定)→ 保守 still-present(不误判已修)', async () => {
    const source = sourceOf({ 'src/config.js': 'totally different code\n' });
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant('I am not sure.')]); // No submit_resolution -> incomplete.
    const r = await reconcilePriorBlocking(deps(source, faux), [prior()]);
    expect(r[0]!.status).toBe('still-present');
  });

  it('flagged 文件不在本 PR head → not-applicable(不门禁不 resolve,不发 LLM)', async () => {
    const source = sourceOf({}); // src/config.js is not in this PR.
    const faux = createFauxAgent();
    faux.setResponses([]); // An unexpected LLM call errors for lack of responses.
    const r = await reconcilePriorBlocking(deps(source, faux), [prior()]);
    expect(r[0]!.status).toBe('not-applicable');
    expect(r[0]!.method).toBe('file-absent');
  });

  // "File not in head" and "workspace gone" must be distinguished: when no path is readable it is undecidable,
  // so prior blocking findings must stay blocking.
  it('工作区整个读不到(不是单个文件缺失)→ still-present,不判 not-applicable', async () => {
    const source: SourceProvider = {
      // The changed-file list still exists (it comes from the diff), but nothing is readable in the workspace.
      listChangedFiles: async () => [
        { path: 'src/config.js', status: 'modified' },
        { path: 'src/other.js', status: 'modified' },
      ],
      readFile: async () => null,
      searchCode: async () => [],
    };
    const faux = createFauxAgent();
    faux.setResponses([]); // An unexpected LLM call errors for lack of responses.
    const r = await reconcilePriorBlocking(deps(source, faux), [prior(), prior({ findingId: 'F2', fingerprint: 'fp2', path: 'src/other.js' })]);
    expect(r.map((x) => x.status)).toEqual(['still-present', 'still-present']);
    expect(r.map((x) => x.method)).toEqual(['workspace-unreadable', 'workspace-unreadable']);
  });

  it('同一基准 sha 的多条 finding 只问一次 git', async () => {
    const source = sourceOf({ 'src/config.js': 'x\n', 'src/other.js': 'y\n' });
    const faux = createFauxAgent();
    faux.setResponses([]);
    let calls = 0;
    const spy: ResolutionDeps['filesChangedSince'] = async () => {
      calls += 1;
      return new Set<string>(); // Neither file changed.
    };
    const r = await reconcilePriorBlocking(deps(source, faux, undefined, spy), [
      prior({ findingId: 'F1', path: 'src/config.js' }),
      prior({ findingId: 'F2', fingerprint: 'fp2', path: 'src/other.js' }),
    ]);
    expect(r.map((x) => x.method)).toEqual(['file-unchanged', 'file-unchanged']);
    expect(calls).toBe(1);
  });

  it('maxVerify 上限:超出的保守保持 blocking(method=verify-capped),不发 LLM', async () => {
    const source = sourceOf({ 'src/config.js': 'changed A\n', 'src/other.js': 'changed B\n' });
    const faux = createFauxAgent();
    // Only one response: the first goes to the LLM (fixed), the second must be stopped by the cap.
    faux.setResponses([faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'ok' }))]);
    const r = await reconcilePriorBlocking(deps(source, faux, 1, changedSince({ 'sha-prev': ['src/config.js', 'src/other.js'] })), [
      prior({ findingId: 'F1', fingerprint: 'fp1', path: 'src/config.js', anchorText: 'A-old' }),
      prior({ findingId: 'F2', fingerprint: 'fp2', path: 'src/other.js', anchorText: 'B-old' }),
    ]);
    expect(r[0]!.status).toBe('resolved');
    expect(r[1]!.status).toBe('still-present');
    expect(r[1]!.method).toBe('verify-capped');
  });
});
