import { zodToJsonSchema } from 'zod-to-json-schema';
import { repositoryConfigSchema } from './schema.js';

export function buildConfigJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(repositoryConfigSchema, {
    name: 'WinnowlConfig',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return schema;
}
