import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

// Public and unauthenticated: no build version or uptime, which would fingerprint the deployed commit.
const healthResponse = z.object({
  status: z.literal('ok'),
});

export function registerHealthRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: '存活与就绪检查',
        response: { 200: healthResponse },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
}
