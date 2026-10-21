import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Fixed advisory lock key so concurrent migrators serialize. */
const MIGRATION_LOCK_KEY = 4_927_310_015;

/** Applies `NNNN_name.sql` files in name order, each in its own transaction; applied versions are recorded in `schema_migrations`. */
export async function runMigrations(pool: pg.Pool, dir: string): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         version text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ version: string }>('select version from schema_migrations');
    const done = new Set(rows.map((r) => r.version));

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) {
        skipped.push(version);
        continue;
      }
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1)', [version]);
        await client.query('commit');
        applied.push(version);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`迁移 ${version} 失败: ${(error as Error).message}`, { cause: error });
      }
    }

    return { applied, skipped };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
