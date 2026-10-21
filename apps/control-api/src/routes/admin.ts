import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../rbac.js';

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/v1/admin/status', { preHandler: requirePermission('installation:manage') }, async () => ({ ok: true }));
}
