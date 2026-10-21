import type { ErasureAuditProof, ErasureTask, RetentionClass } from './types.js';

/** Covers every class except audit, which is kept for compliance. */
export function planInstallationErasure(
  installationId: string,
  resourceCounts: Partial<Record<RetentionClass, number>>,
  requestedAt: number,
): ErasureTask {
  const resources = (Object.entries(resourceCounts) as [RetentionClass, number][])
    .filter(([cls, count]) => cls !== 'audit' && count > 0)
    .map(([cls, count]) => ({ class: cls, count }));
  return { installationId, resources, requestedAt, status: 'pending' };
}

export function completeErasure(task: ErasureTask, completedAt: number): ErasureAuditProof {
  const erasedCounts: Record<string, number> = {};
  for (const r of task.resources) erasedCounts[r.class] = r.count;
  return {
    installationId: task.installationId,
    requestedAt: task.requestedAt,
    completedAt,
    erasedCounts,
    status: 'completed',
  };
}
