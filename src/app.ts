import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db.js';

export interface AppOptions {
  db: Db;
  logger?: boolean;
}

export function buildApp({ db, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/health', async (_req, reply) => {
    try {
      const { rows } = await db.query<{ latest: string | null }>(
        'SELECT max(filename) AS latest FROM public.schema_migrations',
      );
      return { status: 'ok', database: 'ok', schema: rows[0]?.latest ?? null };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  return app;
}
