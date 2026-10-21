/**
 * Status page Worker, deliberately outside the cluster so it stays up when winnowl is down.
 *
 * KV keys:
 * - `last:<id>`  latest probe result
 * - `day:<id>:<YYYY-MM-DD>`  daily ok/fail counts (individual probes are not stored)
 */

export interface Env {
  STATUS_KV: KVNamespace;
  /** JSON array of { id, name, url, expect? }. */
  TARGETS: string;
  SITE_NAME?: string;
}

interface Target {
  id: string;
  name: string;
  url: string;
  /** Substring the body must contain; a 2xx alone does not prove the service works. */
  expect?: string;
}

interface Probe {
  ok: boolean;
  status: number;
  ms: number;
  at: string;
  error?: string;
}

interface DayCount {
  ok: number;
  fail: number;
}

const DAYS = 90;
const PROBE_TIMEOUT_MS = 10_000;
/** Outlives the 90-day window by a week. */
const DAY_TTL_SEC = (DAYS + 7) * 86_400;

/** Reports parse errors instead of silently returning no targets. */
function parseTargets(env: Env): { targets: Target[]; error?: string } {
  try {
    const raw: unknown = JSON.parse(env.TARGETS);
    if (!Array.isArray(raw)) return { targets: [], error: 'TARGETS 不是一个数组' };
    return { targets: raw.filter((t): t is Target => Boolean(t && typeof t === 'object' && 'id' in t && 'url' in t)) };
  } catch (e) {
    return { targets: [], error: `TARGETS 不是合法 JSON:${e instanceof Error ? e.message : String(e)}` };
  }
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

async function probe(t: Target): Promise<Probe> {
  const started = Date.now();
  const at = new Date().toISOString();
  try {
    const res = await fetch(t.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Probe the origin, not a Cloudflare-cached copy.
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { 'user-agent': 'winnowl-status/1.0 (+uptime probe)' },
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, ms, at, error: `HTTP ${res.status}` };
    if (t.expect) {
      const body = await res.text();
      if (!body.includes(t.expect)) {
        return { ok: false, status: res.status, ms, at, error: `body missing ${JSON.stringify(t.expect)}` };
      }
    }
    return { ok: true, status: res.status, ms, at };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      at,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Counts are approximate: KV is eventually consistent, so read-modify-write may occasionally lose an increment.
async function record(env: Env, t: Target, p: Probe, now: Date): Promise<void> {
  const key = `day:${t.id}:${dayKey(now)}`;
  const prev = await env.STATUS_KV.get<DayCount>(key, 'json');
  const next: DayCount = {
    ok: (prev?.ok ?? 0) + (p.ok ? 1 : 0),
    fail: (prev?.fail ?? 0) + (p.ok ? 0 : 1),
  };
  await Promise.all([
    env.STATUS_KV.put(key, JSON.stringify(next), { expirationTtl: DAY_TTL_SEC }),
    env.STATUS_KV.put(`last:${t.id}`, JSON.stringify(p)),
  ]);
}

async function history(env: Env, t: Target, now: Date): Promise<{ date: string; day: DayCount | null }[]> {
  const days: { date: string; day: DayCount | null }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    days.push({ date: dayKey(d), day: null });
  }
  const loaded = await Promise.all(days.map((d) => env.STATUS_KV.get<DayCount>(`day:${t.id}:${d.date}`, 'json')));
  return days.map((d, i) => ({ ...d, day: loaded[i] }));
}

interface TargetView {
  id: string;
  name: string;
  url: string;
  last: Probe | null;
  days: { date: string; day: DayCount | null }[];
  uptime: number | null;
}

async function snapshot(env: Env, now: Date): Promise<TargetView[]> {
  const { targets } = parseTargets(env);
  return Promise.all(
    targets.map(async (t) => {
      const [last, days] = await Promise.all([env.STATUS_KV.get<Probe>(`last:${t.id}`, 'json'), history(env, t, now)]);
      let ok = 0;
      let total = 0;
      for (const d of days) {
        if (!d.day) continue;
        ok += d.day.ok;
        total += d.day.ok + d.day.fail;
      }
      return { id: t.id, name: t.name, url: t.url, last, days, uptime: total ? ok / total : null };
    }),
  );
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

function bar(days: { date: string; day: DayCount | null }[]): string {
  return days
    .map((d) => {
      if (!d.day) return `<i class="d n" title="${d.date} · 无数据"></i>`;
      const total = d.day.ok + d.day.fail;
      const up = total ? d.day.ok / total : 0;
      const cls = d.day.fail === 0 ? 'up' : up >= 0.99 ? 'warn' : 'down';
      return `<i class="d ${cls}" title="${d.date} · ${(up * 100).toFixed(2)}% · ${d.day.fail} 次失败"></i>`;
    })
    .join('');
}

function html(views: TargetView[], siteName: string, now: Date, configError?: string): string {
  const allUp = views.length > 0 && views.every((v) => v.last?.ok);
  const anyData = views.some((v) => v.last);
  const headline = configError ? '状态页自己配错了' : !anyData ? '等待第一次探测' : allUp ? '全部正常' : '部分服务异常';
  const rows = views
    .map(
      (v) => `<section class="svc">
      <header>
        <span class="dot ${v.last ? (v.last.ok ? 'up' : 'down') : 'n'}"></span>
        <h2>${esc(v.name)}</h2>
        <span class="up-pct">${pct(v.uptime)}<small> / ${DAYS} 天</small></span>
      </header>
      <div class="bars">${bar(v.days)}</div>
      <p class="meta">${
        v.last
          ? `${v.last.ok ? `正常 · ${v.last.ms}ms` : `异常 · ${esc(v.last.error ?? `HTTP ${v.last.status}`)}`} · ${esc(v.last.at)}`
          : '还没有探测数据'
      }</p>
    </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(siteName)} 状态</title>
<style>
  :root { color-scheme: dark; --bg:#0b0b0d; --card:#141416; --fg:#f4f4f5; --muted:#8b8b93; --line:#26262b;
          --up:#2ea043; --warn:#d29922; --down:#e5484d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:920px; margin:0 auto; padding:48px 20px 64px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .head { display:flex; align-items:center; gap:10px; margin-bottom:32px; }
  .head .dot { width:12px; height:12px; }
  .muted { color:var(--muted); font-size:14px; margin:0; }
  .svc { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin-bottom:14px; }
  .svc header { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .svc h2 { font-size:15px; font-weight:600; margin:0; flex:1; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--muted); }
  .dot.up { background:var(--up); } .dot.down { background:var(--down); }
  .up-pct { font-variant-numeric:tabular-nums; font-size:14px; color:var(--muted); }
  .bars { display:flex; gap:2px; height:30px; align-items:stretch; }
  .d { flex:1; min-width:2px; border-radius:2px; background:var(--muted); opacity:.25; }
  .d.up { background:var(--up); opacity:1; } .d.warn { background:var(--warn); opacity:1; } .d.down { background:var(--down); opacity:1; }
  .meta { color:var(--muted); font-size:13px; margin:10px 0 0; }
  footer { color:var(--muted); font-size:13px; margin-top:28px; }
  a { color:inherit; }
</style></head>
<body><main>
  <div class="head">
    <span class="dot ${configError ? 'down' : !anyData ? 'n' : allUp ? 'up' : 'down'}"></span>
    <div><h1>${esc(headline)}</h1><p class="muted">${esc(siteName)}</p></div>
  </div>
  ${configError ? `<section class="svc"><p class="meta">${esc(configError)}</p></section>` : ''}
  ${rows || (configError ? '' : '<p class="muted">没有配置探测目标(wrangler.toml 的 TARGETS)。</p>')}
  <footer>每分钟从 Cloudflare 边缘探测一次,与被探测的集群相互独立 · 更新于 ${esc(now.toISOString())} · <a href="/api/status">JSON</a></footer>
</main></body></html>`;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const { targets, error } = parseTargets(env);
    if (error) console.error('TARGETS 解析失败,本次一个目标都没探:', error);
    ctx.waitUntil(
      Promise.all(
        targets.map(async (t) => {
          const p = await probe(t);
          await record(env, t, p, now);
        }),
      ).then(() => undefined),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const now = new Date();
    const siteName = env.SITE_NAME ?? 'winnowl';

    const { error: configError } = parseTargets(env);

    if (url.pathname === '/api/status') {
      const views = await snapshot(env, now);
      return Response.json(
        {
          generatedAt: now.toISOString(),
          ...(configError ? { configError } : {}),
          services: views.map(({ days: _days, ...rest }) => rest),
        },
        { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } },
      );
    }
    if (url.pathname !== '/') return new Response('not found', { status: 404 });

    const views = await snapshot(env, now);
    return new Response(html(views, siteName, now, configError), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};
