/** Usage: DATABASE_URL=postgres://... pnpm db:migrate */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations } from '../src/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺少环境变量 DATABASE_URL');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../migrations');

const pool = createPool({ connectionString });
try {
  const result = await runMigrations(pool, migrationsDir);
  if (result.applied.length > 0) {
    console.log(`已应用迁移: ${result.applied.join(', ')}`);
  }
  console.log(`跳过已应用: ${result.skipped.length} 个`);
} finally {
  await pool.end();
}
