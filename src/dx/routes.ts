/**
 * MyRx DX exchange API, mounted under /dx.
 *
 * Callers act for one organisation (/dx/orgs/:orgId/...): an EMR client acts
 * for the clinic or chamber that places orders, a lab acts for itself.
 * Every call carries an API key (`Authorization: Bearer mrxk_...`) issued to a
 * user in one organisation. The key only works for that organisation's URLs,
 * and acts with that user's current roles there.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTransaction, type Db } from '../db.js';
import { bearerToken } from '../auth/crypto.js';
import * as keys from '../auth/dx-auth.js';
import { forbidden } from '../lis/errors.js';
import * as dx from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const params = (...names: string[]) => ({
  type: 'object', required: ['orgId', ...names],
  properties: Object.fromEntries(['orgId', ...names].map((n) => [n, uuid])),
}) as const;
const release = {
  type: 'object', required: ['decision'], additionalProperties: false,
  properties: {
    decision: { enum: ['held', 'authorised', 'restricted'] },
    reason_code: { enum: ['awaiting_payment', 'pending_review', 'lab_policy', 'patient_request', 'legal', 'other'] },
    reason_text: { type: 'string' },
  },
} as const;

export async function dxRoutes(app: FastifyInstance, { db }: { db: Db }) {
  async function actorFor(req: FastifyRequest): Promise<dx.DxActor> {
    const { orgId } = req.params as { orgId: string };
    const principal = await keys.authenticateKey(db, bearerToken(req.headers.authorization), req.ip);
    keys.requireSameOrg(principal, orgId);
    const actor = await dx.getActor(db, principal.userId, orgId);
    if (!actor) throw forbidden('Not an active member of this organisation');
    return actor;
  }
  async function write<T>(req: FastifyRequest, fn: (c: pg.PoolClient, a: dx.DxActor) => Promise<T>) {
    const actor = await actorFor(req);
    try {
      return await withTransaction(db, actor.userId, (c) => fn(c, actor));
    } catch (err) {
      if (err instanceof dx.AuditedDenial) {
        await dx.audit(db, err.actor, err.action, err.resourceType, err.resourceId, 'denied', err.reason);
      }
      throw err;
    }
  }

  // Directory: which labs offer an investigation
  app.get('/dx/offers', {
    schema: { querystring: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } },
  }, async (req) => {
    await keys.authenticateKey(db, bearerToken(req.headers.authorization), req.ip);
    return dx.findOffers(db, (req.query as { code: string }).code);
  });

  // ---- API keys (organisation admins) -----------------------------------
  async function adminFor(req: FastifyRequest) {
    const actor = await actorFor(req);
    if (!actor.roles.includes('org_admin')) throw forbidden('Only an organisation admin can manage API keys');
    return actor;
  }

  app.get('/dx/orgs/:orgId/api-keys', { schema: { params: params() } }, async (req) => {
    const admin = await adminFor(req);
    return keys.listKeys(db, admin.organisationId);
  });

  app.post('/dx/orgs/:orgId/api-keys', {
    schema: {
      params: params(),
      body: {
        type: 'object', required: ['user_id', 'name'], additionalProperties: false,
        properties: { user_id: uuid, name: { type: 'string', minLength: 1, maxLength: 100 }, expires_at: { type: 'string', format: 'date-time' } },
      },
    },
  }, async (req, reply) => {
    const admin = await adminFor(req);
    const key = await withTransaction(db, admin.userId,
      (c) => keys.createKey(c, admin.organisationId, req.body as keys.NewKeyInput, admin.userId, req.ip));
    return reply.code(201).send(key);
  });

  app.post('/dx/orgs/:orgId/api-keys/:keyId/revoke', { schema: { params: params('keyId') } }, async (req) => {
    const admin = await adminFor(req);
    return keys.revokeKey(db, admin.organisationId, (req.params as { keyId: string }).keyId, admin.userId, req.ip);
  });

  // ---- EMR side ----------------------------------------------------------
  app.post('/dx/orgs/:orgId/orders', {
    schema: {
      params: params(),
      body: {
        type: 'object', required: ['source_system', 'source_order_id', 'patient', 'items'], additionalProperties: false,
        properties: {
          source_system: { type: 'string', minLength: 1 },
          source_order_id: { type: 'string', minLength: 1 },
          patient: {
            type: 'object', required: ['identity_system', 'identity_value'], additionalProperties: false,
            properties: { identity_system: { type: 'string', minLength: 1 }, identity_value: { type: 'string', minLength: 1 } },
          },
          encounter: {
            type: 'object', required: ['source_encounter_id'], additionalProperties: false,
            properties: { source_encounter_id: { type: 'string', minLength: 1 }, encounter_at: { type: 'string', format: 'date-time' } },
          },
          ordering_practitioner_ref: { type: 'string' },
          clinical_indication: { type: 'string' },
          priority: { enum: ['routine', 'urgent', 'stat'] },
          items: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['canonical_code'], additionalProperties: false,
              properties: { canonical_code: { type: 'string' }, clinical_notes: { type: 'string' }, lab_service_offer_id: uuid },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const result = await write(req, (c, a) => dx.submitOrder(c, a, req.body as dx.OrderSubmission));
    return reply.code(result.created ? 201 : 200).send(result.order);
  });

  app.get('/dx/orgs/:orgId/orders/:orderId', { schema: { params: params('orderId') } }, async (req) => {
    const actor = await actorFor(req);
    return dx.orderStatus(db, actor, (req.params as { orderId: string }).orderId);
  });

  app.post('/dx/orgs/:orgId/orders/:orderId/items/:itemId/assign', {
    schema: {
      params: params('orderId', 'itemId'),
      body: { type: 'object', required: ['lab_service_offer_id'], properties: { lab_service_offer_id: uuid } },
    },
  }, async (req) => {
    const { orderId, itemId } = req.params as { orderId: string; itemId: string };
    const { lab_service_offer_id } = req.body as { lab_service_offer_id: string };
    return write(req, (c, a) => dx.assignItem(c, a, orderId, itemId, lab_service_offer_id));
  });

  app.get('/dx/orgs/:orgId/results/feed', {
    schema: {
      params: params(),
      querystring: {
        type: 'object',
        properties: { cursor: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
      },
    },
  }, async (req) => {
    const actor = await actorFor(req);
    const { cursor, limit } = req.query as { cursor: number; limit: number };
    return dx.resultFeed(db, actor, cursor, limit);
  });

  app.get('/dx/orgs/:orgId/patients/results', {
    schema: {
      params: params(),
      querystring: { type: 'object', required: ['system', 'value'], properties: { system: { type: 'string' }, value: { type: 'string' } } },
    },
  }, async (req) => {
    const actor = await actorFor(req);
    const { system, value } = req.query as { system: string; value: string };
    return dx.patientResults(db, actor, system, value);
  });

  // ---- Lab side ----------------------------------------------------------
  app.get('/dx/orgs/:orgId/work', {
    schema: {
      params: params(),
      querystring: { type: 'object', properties: { status: { enum: ['offered', 'accepted', 'in_progress', 'completed'] } } },
    },
  }, async (req) => {
    const actor = await actorFor(req);
    return dx.labWorkQueue(db, actor, (req.query as { status?: string }).status);
  });

  app.post('/dx/orgs/:orgId/assignments/:assignmentId/accept', {
    schema: {
      params: params('assignmentId'),
      body: { type: ['object', 'null'], properties: { external_accession_id: { type: 'string' } } },
    },
  }, async (req) => {
    const { assignmentId } = req.params as { assignmentId: string };
    const body = (req.body ?? {}) as { external_accession_id?: string };
    return write(req, (c, a) => dx.acceptAssignment(c, a, assignmentId, body.external_accession_id));
  });

  app.post('/dx/orgs/:orgId/assignments/:assignmentId/reject', {
    schema: {
      params: params('assignmentId'),
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1 } } },
    },
  }, async (req) => {
    const { assignmentId } = req.params as { assignmentId: string };
    return write(req, (c, a) => dx.rejectAssignment(c, a, assignmentId, (req.body as { reason: string }).reason));
  });

  app.post('/dx/orgs/:orgId/assignments/:assignmentId/results', {
    schema: {
      params: params('assignmentId'),
      body: {
        type: 'object', required: ['source_system', 'idempotency_key', 'status', 'observations', 'report'], additionalProperties: false,
        properties: {
          source_system: { type: 'string', minLength: 1 },
          idempotency_key: { type: 'string', minLength: 1 },
          status: { enum: ['preliminary', 'final', 'corrected'] },
          result_at: { type: 'string', format: 'date-time' },
          source_result_set_id: { type: 'string' },
          observations: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['name', 'value'], additionalProperties: false,
              properties: {
                code: { type: 'string' }, name: { type: 'string', minLength: 1 }, value: { type: ['string', 'number'] },
                unit: { type: 'string' }, reference_range: { type: 'string' }, flag: { type: 'string' },
                observed_at: { type: 'string', format: 'date-time' },
              },
            },
          },
          report: {
            type: 'object', required: ['storage_object_key'], additionalProperties: false,
            properties: { storage_object_key: { type: 'string', minLength: 1 }, media_type: { type: 'string' }, checksum_sha256: { type: 'string' } },
          },
          release,
        },
      },
    },
  }, async (req, reply) => {
    const { assignmentId } = req.params as { assignmentId: string };
    const result = await write(req, (c, a) => dx.submitResults(c, a, assignmentId, req.body as dx.ResultSubmission));
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post('/dx/orgs/:orgId/reports/:reportVersionId/release', {
    schema: { params: params('reportVersionId'), body: release },
  }, async (req) => {
    const { reportVersionId } = req.params as { reportVersionId: string };
    return write(req, (c, a) => dx.decideRelease(c, a, reportVersionId, req.body as Parameters<typeof dx.decideRelease>[3]));
  });
}
