import { describe, expect, it } from 'vitest';
import { reviewPayloadFromSwept } from '../src/review-ack.js';

describe('reviewPayloadFromSwept — 超时回执字段提取(§ack)', () => {
  const full = { tenantId: 't', repositoryId: 'r', changeRequestId: 'c', headSha: 's', extra: 1 };

  it('review_revision 且字段齐全 → 提取', () => {
    expect(reviewPayloadFromSwept('review_revision', full)).toEqual({ tenantId: 't', repositoryId: 'r', changeRequestId: 'c', headSha: 's' });
  });

  it('非 review 类型 → null(不误发回执)', () => {
    expect(reviewPayloadFromSwept('conversation_turn', full)).toBeNull();
    expect(reviewPayloadFromSwept('issue_enrich', full)).toBeNull();
  });

  it('字段缺失/类型不符 → null(不发半残回执)', () => {
    expect(reviewPayloadFromSwept('review_revision', { tenantId: 't', repositoryId: 'r', changeRequestId: 'c' })).toBeNull();
    expect(reviewPayloadFromSwept('review_revision', { tenantId: 't', repositoryId: 'r', changeRequestId: 'c', headSha: 123 })).toBeNull();
    expect(reviewPayloadFromSwept('review_revision', {})).toBeNull();
  });
});
