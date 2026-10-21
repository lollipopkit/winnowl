import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Landing from '../src/routes/(marketing)/+page.svelte';
import LoginDialog from '../src/lib/components/LoginDialog.svelte';
import { initI18n } from '../src/lib/locale';

describe('落地页与登录对话框(§40 #5 渲染测试)', () => {
  beforeAll(() => {
    initI18n();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  // Without vitest globals, testing-library does not auto-cleanup between tests.
  afterEach(cleanup);

  /** Stubs /v1/auth/providers; `instances` are registered self-hosted Forgejo instances. */
  function stubProviders(ids: string[], instances: string[] = []): void {
    const items = [
      ...ids.map((id) => ({ id, label: id === 'github' ? 'GitHub' : id, kind: 'builtin' })),
      ...instances.map((host) => ({ id: host, label: host, kind: 'instance' })),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items }),
      } as unknown as Response),
    );
  }

  it('落地页讲清产品在做什么,登录入口在右上角(未登录时不直接显示表单)', () => {
    stubProviders(['github']);
    render(Landing);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /sign in|登录/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('**不泄露实现细节**:模型/成本/内部管线阶段不出现在未登录页面', () => {
    stubProviders(['github']);
    const { container } = render(Landing);
    const text = container.textContent ?? '';
    for (const secret of ['gpt', 'claude', 'openai', 'anthropic', 'gVisor', 'k3s', 'Keycloak', 'prompt', 'token 成本', '$']) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('登录对话框:按后端返回的登录源渲染按钮;**没有任何凭证输入**(密码在对方站点输)', async () => {
    stubProviders(['github']);
    render(LoginDialog, { props: { open: true } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /github/i })).toBeInTheDocument());
    expect(document.querySelector('input[type="password"]')).toBeNull();
    // No inputs: credentials never pass through this site.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('后端没配登录源 → 明说不可用,而不是给一个按不动的按钮', async () => {
    stubProviders([]);
    render(LoginDialog, { props: { open: true } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /github/i })).toBeNull();
  });

  it('自建实例:只能从已登记的那几台里选,选中后还要按继续', async () => {
    stubProviders(['github'], ['git.example.com']);
    render(LoginDialog, { props: { open: true } });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('[data-select-trigger]')).not.toBeNull());
    const block = document.querySelector('[data-select-trigger]')!.parentElement!;
    expect(block.querySelector('button:last-of-type')).toBeDisabled();
  });

  it('一台自建实例都没登记 → 整块不出现,而不是给一个空下拉', async () => {
    stubProviders(['github']);
    render(LoginDialog, { props: { open: true } });
    await waitFor(() => expect(screen.getByRole('button', { name: /github/i })).toBeInTheDocument());
    expect(document.querySelector('[data-select-trigger]')).toBeNull();
  });
});
