import { CompiledQuery, Kysely, PostgresDialect, type DatabaseConnection, type Dialect, type Driver, type TransactionSettings } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';
import { currentTenantId } from './tenant-context.js';

const { Pool } = pg;

export interface DbPoolOptions {
  connectionString: string;
  max?: number;
  /** An idle connection broke (postgres restarted, network blip). Default: one warning line. */
  onIdleError?: (error: Error) => void;
}

/**
 * The `error` listener is required: node-postgres emits `error` when an idle client's connection dies,
 * and an unhandled `error` event kills the process. The broken client is discarded; the next query reconnects.
 */
export function createPool(options: DbPoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
  });
  pool.on(
    'error',
    options.onIdleError ??
      ((error) => console.warn(JSON.stringify({ level: 40, msg: 'postgres idle connection error', err: error.message }))),
  );
  return pool;
}

/**
 * Sets `app.tenant_id` from the async context on every checkout, always, because a pooled connection may
 * still carry the previous holder's value ('' = no tenant). RLS only applies to non-superuser roles.
 */
class TenantScopingDriver implements Driver {
  constructor(private readonly inner: Driver) {}

  init(): Promise<void> {
    return this.inner.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const conn = await this.inner.acquireConnection();
    const tenant = currentTenantId() ?? '';
    try {
      await conn.executeQuery(CompiledQuery.raw("select set_config('app.tenant_id', $1, false)", [tenant]));
    } catch (error) {
      await this.inner.releaseConnection(conn).catch(() => undefined);
      throw error;
    }
    return conn;
  }

  beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return this.inner.beginTransaction(conn, settings);
  }

  commitTransaction(conn: DatabaseConnection): Promise<void> {
    return this.inner.commitTransaction(conn);
  }

  rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    return this.inner.rollbackTransaction(conn);
  }

  releaseConnection(conn: DatabaseConnection): Promise<void> {
    return this.inner.releaseConnection(conn);
  }

  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  const base = new PostgresDialect({ pool });
  const dialect: Dialect = {
    createAdapter: () => base.createAdapter(),
    createDriver: () => new TenantScopingDriver(base.createDriver()),
    createIntrospector: (db) => base.createIntrospector(db),
    createQueryCompiler: () => base.createQueryCompiler(),
  };
  return new Kysely<Database>({ dialect });
}

export type Db = Kysely<Database>;
