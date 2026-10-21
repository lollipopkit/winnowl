import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { dueFactFeeds, insertFactFeed, listFactFeeds } from '@reviewbot/knowledge';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { refreshDueFactFeeds, refreshFactFeed, type FactFeedDeps } from '../src/fact-feeds.js';

const PAGE = 'https://docs.flutter.dev/release/breaking-changes';

/** Exa /contents stand-in: returns `text` for the page and records the calls. */
function exa(text: () => string) {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body) });
    return new Response(JSON.stringify({ results: [{ url: PAGE, text: text() }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function extractor(facts: Record<string, unknown>[]) {
  const f = createFauxAgent();
  f.setResponses([f.assistant(f.toolCall('submit_facts', { facts }))]);
  return { model: f.model, streamFn: f.streamFn } as ResolvedModelSource;
}

describe('fact feeds (0004): release notes → proposed ecosystem facts', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const logs: string[] = [];

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
  });
  afterAll(async () => stop?.());

  function deps(over: Partial<FactFeedDeps>): FactFeedDeps {
    return { db, resolveModel: () => null, exaApiKey: 'exa-key', log: (_l, m) => void logs.push(m), ...over };
  }

  it('fetches through Exa, extracts facts as proposed origin=feed with the page as source, and skips unchanged content', async () => {
    const feed = await insertFactFeed(db, { ecosystem: 'pub', subject: 'flutter', url: PAGE, createdBy: 'op' });
    let page = 'Flutter 3.50 removes ThemeData.accentColor; use colorScheme.secondary.';
    const { fetchFn, calls } = exa(() => page);
    const model = extractor([
      { subject: 'flutter', versions: '>=3.50.0', claim: 'ThemeData.accentColor was removed.', detail: 'Use colorScheme.secondary.' },
      { subject: '', claim: 'Second fact with the feed subject as default.' },
    ]);

    const first = await refreshFactFeed(feed, deps({ fetchFn, resolveModel: () => model }));
    expect(first).toEqual({ proposed: 2, changed: true });
    expect(calls[0]!.url).toBe('https://api.exa.ai/contents');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ urls: [PAGE] });

    const facts = await db.selectFrom('ecosystem_facts').selectAll().orderBy('created_at').execute();
    expect(facts.map((f) => [f.status, f.origin, f.subject])).toEqual([
      ['proposed', 'feed', 'flutter'],
      ['proposed', 'feed', 'flutter'],
    ]);
    expect(facts[0]!.sources).toEqual([PAGE]);
    expect(facts[0]!.proposed_from).toEqual({ feedId: feed.id, url: PAGE });

    // Same content → no model call, no new facts; the run is still recorded.
    const [stored] = await listFactFeeds(db);
    const second = await refreshFactFeed(stored!, deps({ fetchFn, resolveModel: () => { throw new Error('model must not run'); } }));
    expect(second).toEqual({ proposed: 0, changed: false });
    expect(await dueFactFeeds(db)).toEqual([]);

    // Changed page, same claim again → deduplicated against the existing fact.
    page = `${page}\nAlso nothing new.`;
    const third = await refreshFactFeed((await listFactFeeds(db))[0]!, deps({ fetchFn, resolveModel: () => extractor([{ subject: 'flutter', claim: 'ThemeData.accentColor was removed.' }]) }));
    expect(third).toEqual({ proposed: 0, changed: true });
  });

  it('records a fetch failure on the feed and keeps it due for the next pass', async () => {
    const feed = await insertFactFeed(db, { ecosystem: 'npm', subject: 'react', url: 'https://react.dev/blog', createdBy: 'op' });
    const failing = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await refreshFactFeed(feed, deps({ fetchFn: failing }));
    const row = (await listFactFeeds(db)).find((f) => f.id === feed.id)!;
    expect(row.lastError).toContain('502');
    expect(row.lastContentHash).toBeUndefined();
  });

  it('a pass processes due feeds under the advisory lock', async () => {
    const { fetchFn, calls } = exa(() => 'Next major removes the legacy API.');
    calls.length = 0;
    await db.updateTable('ecosystem_fact_feeds').set({ last_fetched_at: null, last_content_hash: null }).execute();
    await refreshDueFactFeeds(deps({ fetchFn, resolveModel: () => extractor([]) }));
    expect(calls.length).toBe(2); // both feeds
  });
});
