import { listConversationsPage, listMessages, loadConversation } from '@reviewbot/conversation';
import type { Db } from '@reviewbot/db';
import type { FastifyInstance } from 'fastify';
import { paged, parseListParams, strFilter } from '../list-query.js';
import { requirePermission } from '../rbac.js';

const CONVERSATION_SORTS = ['updatedAt', 'state'] as const;

export function registerConversationRoutes(app: FastifyInstance, db: Db): void {
  const read = { preHandler: requirePermission('review:read') };

  app.get('/v1/conversations', read, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const params = parseListParams(req.query, { sortable: CONVERSATION_SORTS, defaultSort: 'updatedAt' });
    const { items, total } = await listConversationsPage(db, tenantId, {
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      dir: params.dir,
      state: strFilter(req.query, 'state'),
      q: strFilter(req.query, 'q'),
    });
    return paged(items, total, params);
  });

  app.get('/v1/conversations/:id', read, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const { id } = req.params as { id: string };
    const conversation = await loadConversation(db, tenantId, id);
    if (!conversation) return reply.code(404).send({ error: 'conversation_not_found' });
    const messages = await listMessages(db, id);
    return { conversation, messages };
  });
}
