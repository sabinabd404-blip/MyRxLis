/**
 * LIS Lite HTTP API, mounted under /labs/:labId.
 *
 * Staff sign in with POST /labs/:labId/auth/login and send the session token
 * as `Authorization: Bearer <token>` on every other request. A session only
 * works for the lab it was issued in.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTransaction, type Db } from '../db.js';
import * as auth from '../auth/lis-auth.js';
import { bearerToken, PASSWORD_MAX } from '../auth/crypto.js';
import * as bridge from '../bridge/lis-dx.js';
import * as lis from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const labParams = { type: 'object', required: ['labId'], properties: { labId: uuid } } as const;
const idParams = (name: string) =>
  ({ type: 'object', required: ['labId', name], properties: { labId: uuid, [name]: uuid } }) as const;

type LabReq = FastifyRequest<{ Params: { labId: string } }>;

export async function lisRoutes(app: FastifyInstance, { db, policy }: { db: Db; policy: auth.AuthPolicy }) {
  const meta = (req: FastifyRequest): auth.RequestMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

  async function staffFor(req: FastifyRequest) {
    const { labId } = req.params as { labId: string };
    return auth.authenticate(db, labId, bearerToken(req.headers.authorization));
  }

  /** Run a write as the requesting staff member, in one transaction, recorded in the audit trail. */
  async function write<T>(req: FastifyRequest, fn: (c: pg.PoolClient, staff: lis.Staff) => Promise<T>): Promise<T> {
    const staff = await staffFor(req);
    return withTransaction(db, staff.id, (c) => fn(c, staff));
  }

  // --- Sign-in -------------------------------------------------------------
  const password = { type: 'string', minLength: 1, maxLength: PASSWORD_MAX } as const;

  app.post('/labs/:labId/auth/login', {
    schema: {
      params: labParams,
      body: {
        type: 'object', required: ['username', 'password'], additionalProperties: false,
        properties: { username: { type: 'string', minLength: 1, maxLength: 100 }, password },
      },
    },
  }, async (req) => {
    const { labId } = req.params as { labId: string };
    const { username, password: pw } = req.body as { username: string; password: string };
    return auth.login(db, labId, username, pw, policy, meta(req));
  });

  app.post('/labs/:labId/auth/logout', { schema: { params: labParams } }, async (req, reply) => {
    await auth.logout(db, await staffFor(req), meta(req));
    return reply.code(204).send();
  });

  app.get('/labs/:labId/auth/me', { schema: { params: labParams } }, async (req) => {
    const { session_id: _s, ...staff } = await staffFor(req);
    return staff;
  });

  app.put('/labs/:labId/auth/password', {
    schema: {
      params: labParams,
      body: {
        type: 'object', required: ['current_password', 'new_password'], additionalProperties: false,
        properties: { current_password: password, new_password: password },
      },
    },
  }, async (req, reply) => {
    const { current_password, new_password } = req.body as { current_password: string; new_password: string };
    await auth.changeOwnPassword(db, await staffFor(req), current_password, new_password, meta(req));
    return reply.code(204).send();
  });

  app.put('/labs/:labId/staff/:staffId/password', {
    schema: {
      params: idParams('staffId'),
      body: { type: 'object', required: ['new_password'], additionalProperties: false, properties: { new_password: password } },
    },
  }, async (req, reply) => {
    const { staffId } = req.params as { staffId: string };
    await auth.setStaffPassword(db, await staffFor(req), staffId, (req.body as { new_password: string }).new_password, meta(req));
    return reply.code(204).send();
  });

  // --- Patients -----------------------------------------------------------
  app.post('/labs/:labId/patients', {
    schema: {
      params: labParams,
      body: {
        type: 'object', required: ['full_name', 'sex'], additionalProperties: false,
        properties: {
          full_name: { type: 'string', minLength: 1 }, full_name_bn: { type: 'string' },
          sex: { enum: ['male', 'female', 'other', 'unknown'] }, date_of_birth: { type: 'string', format: 'date' },
          phone: { type: 'string' }, address: { type: 'string' }, myrx_patient_ref: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const patient = await write(req, (c, s) => lis.registerPatient(c, s, req.body as lis.PatientInput));
    return reply.code(201).send(patient);
  });

  app.get('/labs/:labId/patients', {
    schema: { params: labParams, querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } },
  }, async (req) => {
    const staff = await staffFor(req);
    return lis.searchPatients(db, staff.lab_id, (req.query as { q: string }).q);
  });

  // --- Catalogue ----------------------------------------------------------
  app.get('/labs/:labId/tests', { schema: { params: labParams } }, async (req: LabReq) => {
    const staff = await staffFor(req);
    return lis.listTests(db, staff.lab_id);
  });

  // --- Orders -------------------------------------------------------------
  app.post('/labs/:labId/orders', {
    schema: {
      params: labParams,
      body: {
        type: 'object', required: ['patient_id', 'test_ids'], additionalProperties: false,
        properties: {
          patient_id: uuid, referring_doctor_id: uuid,
          age: {
            type: 'object', additionalProperties: false,
            properties: { years: { type: 'number', minimum: 0 }, months: { type: 'number', minimum: 0 }, days: { type: 'number', minimum: 0 } },
          },
          test_ids: { type: 'array', minItems: 1, items: uuid },
          discount: { type: 'number', minimum: 0 }, notes: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const order = await write(req, (c, s) => lis.createOrder(c, s, req.body as lis.OrderInput));
    return reply.code(201).send(order);
  });

  app.get('/labs/:labId/orders/:orderId', { schema: { params: idParams('orderId') } }, async (req) => {
    const staff = await staffFor(req);
    return lis.getOrder(db, staff.lab_id, (req.params as { orderId: string }).orderId);
  });

  app.post('/labs/:labId/orders/:orderId/payments', {
    schema: {
      params: idParams('orderId'),
      body: {
        type: 'object', required: ['amount', 'method'], additionalProperties: false,
        properties: {
          amount: { type: 'number', exclusiveMinimum: 0 },
          method: { enum: ['cash', 'card', 'bkash', 'nagad', 'rocket', 'bank', 'other'] },
          kind: { enum: ['payment', 'refund'] },
        },
      },
    },
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const result = await write(req, async (c, s) => {
      const r = await lis.recordPayment(c, s, orderId, req.body as lis.PaymentInput);
      // Reports authorised by this payment become available in MyRx DX too.
      const dx_decisions_updated = r.reports_authorised ? await bridge.syncReleaseDecisions(c, s.lab_id, orderId) : 0;
      return { ...r, dx_decisions_updated };
    });
    return reply.code(201).send(result);
  });

  app.post('/labs/:labId/orders/:orderId/release', {
    schema: {
      params: idParams('orderId'),
      body: {
        type: ['object', 'null'], additionalProperties: false,
        properties: { amendment_reason: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { orderId } = req.params as { orderId: string };
    const body = (req.body ?? {}) as { amendment_reason?: string };
    const report = await write(req, async (c, s) => {
      const r = await lis.releaseReport(c, s, orderId, body);
      // Results for MyRx DX orders go back to DX in the same transaction.
      const dx_results_sent = await bridge.pushRelease(c, s.lab_id, r);
      return { ...r, dx_results_sent };
    });
    return reply.code(201).send(report);
  });

  // --- Specimens ----------------------------------------------------------
  app.post('/labs/:labId/specimens/:specimenId/collect', { schema: { params: idParams('specimenId') } }, async (req) => {
    const { specimenId } = req.params as { specimenId: string };
    return write(req, (c, s) => lis.collectSpecimen(c, s, specimenId));
  });

  app.post('/labs/:labId/specimens/:specimenId/receive', { schema: { params: idParams('specimenId') } }, async (req) => {
    const { specimenId } = req.params as { specimenId: string };
    return write(req, (c, s) => lis.receiveSpecimen(c, s, specimenId));
  });

  // --- Ordered tests ------------------------------------------------------
  app.put('/labs/:labId/order-tests/:orderTestId/results', {
    schema: {
      params: idParams('orderTestId'),
      body: {
        type: 'object', required: ['results'], additionalProperties: false,
        properties: {
          results: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['parameter_code', 'value'], additionalProperties: false,
              properties: { parameter_code: { type: 'string' }, value: { type: ['string', 'number'] } },
            },
          },
        },
      },
    },
  }, async (req) => {
    const { orderTestId } = req.params as { orderTestId: string };
    const { results } = req.body as { results: lis.ResultValue[] };
    return write(req, (c, s) => lis.enterResults(c, s, orderTestId, results));
  });

  app.post('/labs/:labId/order-tests/:orderTestId/validate', { schema: { params: idParams('orderTestId') } }, async (req) => {
    const { orderTestId } = req.params as { orderTestId: string };
    return write(req, (c, s) => lis.validateTest(c, s, orderTestId));
  });

  app.post('/labs/:labId/order-tests/:orderTestId/reopen', { schema: { params: idParams('orderTestId') } }, async (req) => {
    const { orderTestId } = req.params as { orderTestId: string };
    return write(req, (c, s) => lis.reopenTest(c, s, orderTestId));
  });

  app.post('/labs/:labId/order-tests/:orderTestId/cancel', {
    schema: {
      params: idParams('orderTestId'),
      body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1 } } },
    },
  }, async (req) => {
    const { orderTestId } = req.params as { orderTestId: string };
    return write(req, (c, s) => lis.cancelTest(c, s, orderTestId, (req.body as { reason: string }).reason));
  });

  // --- MyRx DX inbox -----------------------------------------------------
  app.get('/labs/:labId/dx/inbox', { schema: { params: labParams } }, async (req) => {
    const staff = await staffFor(req);
    return bridge.inbox(db, staff);
  });

  app.post('/labs/:labId/dx/import', {
    schema: {
      params: labParams,
      body: {
        type: 'object', required: ['assignment_ids'], additionalProperties: false,
        properties: {
          assignment_ids: { type: 'array', minItems: 1, items: uuid },
          patient_id: uuid,
          patient: {
            type: 'object', required: ['full_name', 'sex'], additionalProperties: false,
            properties: {
              full_name: { type: 'string', minLength: 1 }, full_name_bn: { type: 'string' },
              sex: { enum: ['male', 'female', 'other', 'unknown'] }, date_of_birth: { type: 'string', format: 'date' },
              phone: { type: 'string' }, address: { type: 'string' },
            },
          },
          age: {
            type: 'object', additionalProperties: false,
            properties: { years: { type: 'number', minimum: 0 }, months: { type: 'number', minimum: 0 }, days: { type: 'number', minimum: 0 } },
          },
          referring_doctor_id: uuid,
        },
      },
    },
  }, async (req, reply) => {
    const order = await write(req, (c, s) => bridge.importAssignments(c, s, req.body as bridge.ImportInput));
    return reply.code(201).send(order);
  });

  // --- Reports and summary ------------------------------------------------
  app.get('/labs/:labId/reports/:reportId', { schema: { params: idParams('reportId') } }, async (req) => {
    const staff = await staffFor(req);
    return lis.getReport(db, staff.lab_id, (req.params as { reportId: string }).reportId);
  });

  app.get('/labs/:labId/summary', {
    schema: { params: labParams, querystring: { type: 'object', required: ['date'], properties: { date: { type: 'string' } } } },
  }, async (req) => {
    const staff = await staffFor(req);
    return lis.dailySummary(db, staff.lab_id, (req.query as { date: string }).date);
  });
}
