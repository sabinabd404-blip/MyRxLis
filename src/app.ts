import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Db } from './db.js';
import { HttpError } from './lis/errors.js';
import { dxRoutes } from './dx/routes.js';
import { lisRoutes } from './lis/routes.js';

export interface AppOptions {
  db: Db;
  logger?: boolean;
}

// PostgreSQL error codes raised by our constraints and triggers.
const PG_CONFLICT = new Set(['23505', '23514', '23503', '23P01']);

export function buildApp({ db, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger, ajv: { customOptions: { allowUnionTypes: true } } });

  app.setErrorHandler((err: FastifyError & { code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err.validation) {
      return reply.code(400).send({ error: err.message });
    }
    if (err.code && PG_CONFLICT.has(err.code)) {
      // A database rule rejected the change; its message is written for people.
      return reply.code(409).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

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

  app.register(lisRoutes, { db });
  app.register(dxRoutes, { db });

  return app;
}
