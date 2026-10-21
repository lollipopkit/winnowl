import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Me, ReviewProgressItem } from '../src/lib/api';
import { initI18n } from '../src/lib/locale';

// Internal pipeline stage names must never reach the UI: the backend sends only step index/count.
// The cross-tenant toggle is operator-only.
const ITEM: ReviewProgressItem = {
  jobId: 'j1',
  repository: 'acme/app',
  changeNumber: 206,
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  stepIndex: 2,
  stepCount: 6,
  countKind: 'areas',
  outcome: null,
  done: 4,
  total: 11,
  attempt: 1,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  finishedAt: null,
};

let operator = false;
let role = 'viewer';
let reviewFailure = false;

vi.mock('$lib/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: {
    reviewProgress: async (): Promise<{ items: ReviewProgressItem[] }> => {
      if (reviewFailure) throw new Error('progress unavailable');
      return { items: [ITEM] };
    },
  },
}));
vi.mock('$lib/me', () => ({
  get me() {
    return readable<Me | null>({ isOperator: operator, role } as Me);
  },
  roleAtLeast: (value: string | undefined, min: string) => {
    const rank: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
    return (rank[value ?? 'viewer'] ?? 0) >= (rank[min] ?? 0);
  },
}));

const { default: ReviewProgress } = await import('../src/lib/components/ReviewProgress.svelte');

describe('ReviewProgress —— 内部阶段名不进普通用户视图(0075)', () => {
  beforeAll(() => initI18n());
  afterEach(() => cleanup());

  it('普通用户:看得到普通话步骤与计数,没有「全部租户」开关', async () => {
    operator = false;
    role = 'viewer';
    const { container } = render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('4/11 areas')).toBeInTheDocument();
    for (const w of ['dig', 'map', 'verify', 'synthesis', 'prepare', 'publish']) {
      expect(container.textContent).not.toContain(w);
    }
    expect(screen.queryByText('All tenants')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('运维:多出「全部租户」开关,但**同样看不到**内部阶段词', async () => {
    operator = true;
    const { container } = render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());

    expect(screen.getByText('All tenants')).toBeInTheDocument();
    for (const w of ['dig', 'map', 'verify']) {
      expect(container.textContent).not.toContain(w);
    }
  });

  it('首次拉取失败显示错误,不伪装成成功的空状态', async () => {
    reviewFailure = true;
    try {
      render(ReviewProgress);
      await waitFor(() => expect(screen.getByText(/progress unavailable/)).toBeInTheDocument());
      expect(screen.queryByText('No reviews in progress')).toBeNull();
    } finally {
      reviewFailure = false;
    }
  });

  // Optional details stay inline so all rows keep the same height.
  it('计数挂在当前那一步上,不另占一行', async () => {
    operator = true;
    const { container } = render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());

    const current = container.querySelector('.progress-steps li.current');
    expect(current).not.toBeNull();
    expect(current!.textContent).toContain('4/11 areas');
  });

  // Labels are positional; a stepCount mismatch would shift them silently, so the stepper is hidden.
  it('stepCount 与本地标签数不符 → 不画步骤条(不拿可能错位的标签糊弄读者)', async () => {
    operator = false;
    ITEM.stepCount = 7;
    const { container } = render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());
    expect(container.querySelector('.progress-steps')).toBeNull();
    expect(container.textContent).not.toContain('Thinking');
    ITEM.stepCount = 6;
  });

  it('stepIndex 越界 → 不画步骤条', async () => {
    ITEM.stepIndex = 6;
    const { container } = render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());
    expect(container.querySelector('.progress-steps')).toBeNull();
    ITEM.stepIndex = 2;
  });

  it('时长格恒一行 —— 尝试次数是它的从句,不是下面新起的一行', async () => {
    operator = false;
    render(ReviewProgress);
    await waitFor(() => expect(screen.getByText('acme/app')).toBeInTheDocument());
    const durationCell = screen.getByText(/running/).closest('td');
    expect(durationCell).not.toBeNull();
    expect(durationCell!.querySelectorAll('div')).toHaveLength(0);
  });
});
