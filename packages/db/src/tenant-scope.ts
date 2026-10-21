import { sql, type Transaction } from 'kysely';
import type { Database } from './schema.js';
import type { Db } from './client.js';

/**
 * Runs `fn` in a transaction with `app.tenant_id` set locally, so RLS limits it to that tenant's rows
 * (plus NULL-tenant system rows). RLS does not apply to superuser/BYPASSRLS connections.
 */
export async function withTenantScope<T>(db: Db, tenantId: string, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}
