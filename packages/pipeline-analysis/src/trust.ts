import type { CiTrust, CiTrustInput } from './types.js';

/** Every weakening condition becomes a visible caveat. Only rates failure evidence; a pass proves nothing. */
export function assessCiTrust(input: CiTrustInput): CiTrust {
  const caveats: string[] = [];
  if (input.jobHeadSha !== input.currentHeadSha) {
    caveats.push(`CI 运行的 Head(${input.jobHeadSha})与当前 Head(${input.currentHeadSha})不一致`);
  }
  if (!input.logsComplete) caveats.push('日志不完整');
  if (input.flaky) caveats.push('疑似 flaky(历史抖动)');
  if (!input.trustedEnvironment) caveats.push('非可信环境运行');
  if (input.workflowModifiedByUntrustedPr) caveats.push('Workflow 被不可信 PR 修改');
  return { trustworthy: caveats.length === 0, caveats };
}
