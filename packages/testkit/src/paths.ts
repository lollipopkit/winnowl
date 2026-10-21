import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** src and dist sit at the same depth, so this resolves from both. */
export const migrationsDir = resolve(here, '../../../migrations');
