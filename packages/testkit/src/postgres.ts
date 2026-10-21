import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPool, runMigrations, type MigrationResult } from '@reviewbot/db';
import type pg from 'pg';
import { migrationsDir } from './paths.js';

export interface StartedPostgres {
  container: StartedPostgreSqlContainer;
  connectionString: string;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionString = container.getConnectionUri();
  return {
    container,
    connectionString,
    stop: async () => {
      await container.stop();
    },
  };
}

export function applyMigrations(pool: pg.Pool): Promise<MigrationResult> {
  return runMigrations(pool, migrationsDir);
}

export async function startMigratedPostgres(): Promise<{
  connectionString: string;
  pool: pg.Pool;
  stop(): Promise<void>;
}> {
  const started = await startPostgres();
  const pool = createPool({ connectionString: started.connectionString });
  // Teardown can stop the database under idle clients; node-postgres emits that on the Pool, and
  // unhandled it fails the run with an uncaught 57P01. Active queries still reject on their own.
  pool.on('error', () => undefined);
  await applyMigrations(pool);
  return {
    connectionString: started.connectionString,
    pool,
    stop: async () => {
      await pool.end();
      await started.stop();
    },
  };
}
