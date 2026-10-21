import { describe, expect, it } from 'vitest';
import { listByokModels } from '../src/byok.js';

/** Records requests; answers by URL. */
function provider(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    const r = routes[String(url)];
    if (!r) return new Response('not found', { status: 404 });
    return Response.json(r.body ?? {}, { status: r.status ?? 200 });
  };
  return { seen, fetchImpl };
}

describe('listByokModels', () => {
  it('asks the fixed endpoint of each provider with its own auth header', async () => {
    const openai = provider({ 'https://api.openai.com/v1/models': { body: { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] } } });
    expect(await listByokModels('openai', 'sk', openai.fetchImpl)).toEqual(['a', 'b']);
    expect(openai.seen[0]!.headers.get('authorization')).toBe('Bearer sk');

    const anthropic = provider({ 'https://api.anthropic.com/v1/models?limit=1000': { body: { data: [{ id: 'claude-x' }] } } });
    expect(await listByokModels('anthropic', 'sk-ant', anthropic.fetchImpl)).toEqual(['claude-x']);
    expect(anthropic.seen[0]!.headers.get('x-api-key')).toBe('sk-ant');
    expect(anthropic.seen[0]!.headers.get('authorization')).toBeNull();

    const deepseek = provider({ 'https://api.deepseek.com/models': { body: { data: [{ id: 'deepseek-chat' }] } } });
    expect(await listByokModels('deepseek', 'sk', deepseek.fetchImpl)).toEqual(['deepseek-chat']);
  });

  it('checks an OpenRouter key on its own endpoint (the model list is public)', async () => {
    const bad = provider({ 'https://openrouter.ai/api/v1/key': { status: 401 }, 'https://openrouter.ai/api/v1/models': { body: { data: [{ id: 'x/y' }] } } });
    await expect(listByokModels('openrouter', 'sk', bad.fetchImpl)).rejects.toMatchObject({ code: 'key_rejected' });
    const good = provider({ 'https://openrouter.ai/api/v1/key': { body: { data: {} } }, 'https://openrouter.ai/api/v1/models': { body: { data: [{ id: 'x/y' }] } } });
    expect(await listByokModels('openrouter', 'sk', good.fetchImpl)).toEqual(['x/y']);
  });

  it('tells a rejected key from a provider error', async () => {
    const err = provider({ 'https://api.openai.com/v1/models': { status: 500 } });
    await expect(listByokModels('openai', 'sk', err.fetchImpl)).rejects.toMatchObject({ code: 'provider_error', status: 500 });
    const forbidden = provider({ 'https://api.openai.com/v1/models': { status: 403 } });
    await expect(listByokModels('openai', 'sk', forbidden.fetchImpl)).rejects.toMatchObject({ code: 'key_rejected' });
  });
});
