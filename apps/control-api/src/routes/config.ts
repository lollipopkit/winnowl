import { buildConfigJsonSchema, defaultConfig } from '@reviewbot/config';
import type { FastifyInstance } from 'fastify';

export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/v1/config/schema', async () => buildConfigJsonSchema());
  app.get('/v1/config/default', async () => defaultConfig());
}
