import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { findOrCreateConversationByTarget } from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();

describe('conversation target identity', () => {
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
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: CR,
        number: 1,
        kind: 'pull-request',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('does not let an unresolved webhook inherit a bound conversation', async () => {
    const bound = await findOrCreateConversationByTarget(db, {
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: 'bound-1' },
      repositoryId: REPO,
      changeRequestId: CR,
    });
    // Empty bindings are part of the identity, not a wildcard.
    const unbound = await findOrCreateConversationByTarget(db, {
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: 'bound-1' },
    });
    expect(unbound.id).not.toBe(bound.id);
  });
});
