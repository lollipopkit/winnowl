import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { ReviewFileState } from '../src/file-state.js';
import { filesWithStaleDependencies, partitionReviewFiles, recordCoveredFiles } from '../src/pr-coverage.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const OTHER_CR = uuidv7();
const CONTRACT = 'c'.repeat(64);

function file(path: string, digest: string): ReviewFileState {
  return {
    path,
    oldPath: path,
    newPath: path,
    status: 'modified',
    materialDigest: digest.repeat(64),
  };
}

/** (kind, number) is unique per repository. */
let crNumber = 0;

describe('incremental review coverage state', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('provider_hosts')
      .values({
        id: HOST,
        tenant_id: TENANT,
        provider: 'github',
        base_url: 'x',
        api_url: 'x',
        is_saas: true,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('installations')
      .values({
        id: INSTALL,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: '1',
        account_login: 'acme',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPO,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '900',
        namespace: 'acme',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    for (const id of [CR, OTHER_CR]) {
      await db
        .insertInto('change_requests')
        .values({
          id,
          tenant_id: TENANT,
          repository_id: REPO,
          native_id: id,
          number: (crNumber += 1),
          kind: 'pull-request',
          state: 'open',
          draft: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    }
  });

  beforeEach(async () => {
    await db.deleteFrom('pr_coverage').execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('classifies every file as delta before an exact state is recorded', async () => {
    const files = [file('a.ts', 'a'), file('b.ts', 'b')];
    expect(
      await partitionReviewFiles({
        db,
        tenantId: TENANT,
        changeRequestId: CR,
        files,
        reviewContractDigest: CONTRACT,
      }),
    ).toMatchObject({ deltaFiles: files, priorFiles: [] });
  });

  it('reuses exact material under the same contract across head commits', async () => {
    const files = [file('a.ts', 'a'), file('b.ts', 'b')];
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [files[0]!],
    });
    expect(
      await partitionReviewFiles({
        db,
        tenantId: TENANT,
        changeRequestId: CR,
        files,
        reviewContractDigest: CONTRACT,
      }),
    ).toEqual({
      deltaFiles: [files[1]],
      priorFiles: [files[0]],
      coveredAtSha: new Map([['a.ts', 'head-1']]),
      dependencies: new Map([['a.ts', []]]),
      previous: new Map([['a.ts', { coveredAtSha: 'head-1' }]]),
    });
  });

  it('invalidates coverage when material or the review contract changes', async () => {
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [file('a.ts', 'a')],
    });
    const changed = file('a.ts', 'b');
    expect(
      (
        await partitionReviewFiles({
          db,
          tenantId: TENANT,
          changeRequestId: CR,
          files: [changed],
          reviewContractDigest: CONTRACT,
        })
      ).deltaFiles,
    ).toEqual([changed]);
    const same = file('a.ts', 'a');
    expect(
      (
        await partitionReviewFiles({
          db,
          tenantId: TENANT,
          changeRequestId: CR,
          files: [same],
          reviewContractDigest: 'd'.repeat(64),
        })
      ).deltaFiles,
    ).toEqual([same]);
  });

  it('treats legacy rows and malformed current states as delta', async () => {
    await db
      .insertInto('pr_coverage')
      .values({
        tenant_id: TENANT,
        change_request_id: CR,
        path: 'a.ts',
        covered_at_sha: 'legacy-head',
        covered_at: new Date(),
        material_digest: null,
        review_contract_digest: null,
      })
      .execute();
    const current = file('a.ts', 'a');
    expect(
      (
        await partitionReviewFiles({
          db,
          tenantId: TENANT,
          changeRequestId: CR,
          files: [current],
          reviewContractDigest: CONTRACT,
        })
      ).deltaFiles,
    ).toEqual([current]);
    const malformed = { ...current, materialDigest: 'not-a-digest' };
    expect(
      (
        await partitionReviewFiles({
          db,
          tenantId: TENANT,
          changeRequestId: CR,
          files: [malformed],
          reviewContractDigest: CONTRACT,
        })
      ).deltaFiles,
    ).toEqual([malformed]);
  });

  it('fails closed when a current state has inconsistent path or status metadata', async () => {
    const current = file('a.ts', 'a');
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [current],
    });
    const malformed = [
      { ...current, status: 'unknown' as ReviewFileState['status'] },
      { ...current, status: 'added' as const, oldPath: 'a.ts' },
      { ...current, path: 'other.ts' },
    ];
    for (const state of malformed) {
      expect(
        (
          await partitionReviewFiles({
            db,
            tenantId: TENANT,
            changeRequestId: CR,
            files: [state],
            reviewContractDigest: CONTRACT,
          })
        ).deltaFiles,
      ).toEqual([state]);
    }
  });

  it('updates state atomically and keeps change requests isolated', async () => {
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [file('a.ts', 'a')],
    });
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-2',
      reviewContractDigest: 'd'.repeat(64),
      files: [file('a.ts', 'b')],
    });
    expect(
      await db
        .selectFrom('pr_coverage')
        .select(['covered_at_sha', 'material_digest', 'review_contract_digest'])
        .where('change_request_id', '=', CR)
        .executeTakeFirst(),
    ).toEqual({
      covered_at_sha: 'head-2',
      material_digest: 'b'.repeat(64),
      review_contract_digest: 'd'.repeat(64),
    });
    const other = file('a.ts', 'b');
    expect(
      (
        await partitionReviewFiles({
          db,
          tenantId: TENANT,
          changeRequestId: OTHER_CR,
          files: [other],
          reviewContractDigest: 'd'.repeat(64),
        })
      ).deltaFiles,
    ).toEqual([other]);
  });

  it('drops conflicting duplicates rather than persisting an ambiguous state', async () => {
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [file('a.ts', 'a'), file('a.ts', 'b')],
    });
    expect(
      await db
        .selectFrom('pr_coverage')
        .select('path')
        .where('change_request_id', '=', CR)
        .execute(),
    ).toEqual([]);
  });

  // a.ts's review read lib.ts; lib.ts changed since, so a.ts is stale although it did not change.
  it('records what a file review read and flags it stale when a dependency changes', async () => {
    const files = [file('a.ts', 'a'), file('b.ts', 'b')];
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [
        { ...files[0]!, dependencies: ['lib.ts', 'types.ts'] },
        { ...files[1]!, dependencies: [] },
      ],
    });
    const partition = await partitionReviewFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      files,
      reviewContractDigest: CONTRACT,
    });
    expect(partition.dependencies.get('a.ts')).toEqual(['lib.ts', 'types.ts']);

    const asked: string[] = [];
    const since = (changed: string[] | null) => async (sha: string) => {
      asked.push(sha);
      return changed ? new Set(changed) : null;
    };
    expect(await filesWithStaleDependencies(partition, since(['lib.ts']))).toEqual(new Set(['a.ts']));
    expect(asked).toEqual(['head-1']); // asked once per sha; b.ts has no dependencies
    expect(await filesWithStaleDependencies(partition, since(['README.md']))).toEqual(new Set());
    // Unknown counts as stale.
    expect(await filesWithStaleDependencies(partition, since(null))).toEqual(new Set(['a.ts']));
  });

  it('keeps the previous note and head for prior and changed files alike', async () => {
    await recordCoveredFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      headSha: 'head-1',
      reviewContractDigest: CONTRACT,
      files: [
        { ...file('a.ts', 'a'), note: 'a() validates input' },
        { ...file('b.ts', 'b'), note: 'b() caches results' },
      ],
    });
    const partition = await partitionReviewFiles({
      db,
      tenantId: TENANT,
      changeRequestId: CR,
      files: [file('a.ts', 'a'), file('b.ts', 'e')], // b.ts changed since
      reviewContractDigest: CONTRACT,
    });
    expect(partition.deltaFiles.map((f) => f.path)).toEqual(['b.ts']);
    expect(partition.previous).toEqual(
      new Map([
        ['a.ts', { coveredAtSha: 'head-1', note: 'a() validates input' }],
        ['b.ts', { coveredAtSha: 'head-1', note: 'b() caches results' }],
      ]),
    );
  });
});
