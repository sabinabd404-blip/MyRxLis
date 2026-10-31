/**
 * MyRx DX API keys: how the MyRx EMR and a lab's own LIS sign their calls.
 *
 * A key is issued to one user in one organisation (normally an
 * integration_service user) and acts with that user's roles there. The key
 * value is shown once, when it is created.
 */
import type pg from 'pg';
import type { Db } from '../db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lis/errors.js';
import { hashToken, newApiKey } from './crypto.js';
import { recordAuthEvent } from './events.js';

type Q = Db | pg.PoolClient;

export interface ApiKeyPrincipal { keyId: string; userId: string; organisationId: string }

export async function authenticateKey(db: Db, key: string | null, ip?: string): Promise<ApiKeyPrincipal> {
  if (!key) throw unauthorized('API key required: send Authorization: Bearer <MyRx DX API key>');
  const { rows: [k] } = await db.query<{ id: string; user_id: string; organisation_id: string; usable: boolean; stale: boolean }>(
    `SELECT id, user_id, organisation_id,
            revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AS usable,
            last_used_at IS NULL OR last_used_at < now() - interval '1 minute' AS stale
     FROM dx_api_keys WHERE key_hash = $1`, [hashToken(key)]);
  if (!k || !k.usable) {
    await recordAuthEvent(db, { event: 'api_key_rejected', subject_type: k ? 'dx_api_key' : 'unknown',
      subject_id: k?.id ?? null, organisation_id: k?.organisation_id ?? null, source_ip: ip,
      detail: { reason: k ? 'revoked_or_expired' : 'unknown_key' } });
    throw unauthorized('API key is not valid');
  }
  if (k.stale) await db.query('UPDATE dx_api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
  return { keyId: k.id, userId: k.user_id, organisationId: k.organisation_id };
}

export interface NewKeyInput { user_id: string; name: string; expires_at?: string }

/** Issue a key for a member of the organisation. Returns the key value once. */
export async function createKey(c: Q, organisationId: string, input: NewKeyInput, createdBy: string | null, ip?: string) {
  const { rows: [m] } = await c.query(
    `SELECT 1 FROM organisation_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organisation_id = $1 AND m.user_id = $2 AND m.status = 'active' AND u.status = 'active' LIMIT 1`,
    [organisationId, input.user_id]);
  if (!m) throw badRequest('A key can only be issued to an active member of this organisation');
  const { key, prefix } = newApiKey();
  const { rows: [row] } = await c.query<{ id: string; organisation_id: string; user_id: string; name: string;
    key_prefix: string; created_at: Date; expires_at: Date | null }>(
    `INSERT INTO dx_api_keys (organisation_id, user_id, name, key_prefix, key_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, organisation_id, user_id, name, key_prefix, created_at, expires_at`,
    [organisationId, input.user_id, input.name, prefix, hashToken(key), createdBy, input.expires_at ?? null]);
  await recordAuthEvent(c, { event: 'api_key_created', subject_type: 'dx_api_key', subject_id: row!.id,
    organisation_id: organisationId, actor_ref: createdBy ?? 'cli', source_ip: ip, detail: { for_user: input.user_id } });
  return { ...row!, key };
}

export async function listKeys(c: Q, organisationId: string) {
  const { rows } = await c.query(
    `SELECT k.id, k.name, k.key_prefix, k.user_id, u.display_name AS user_name, k.created_at, k.expires_at,
            k.last_used_at, k.revoked_at
     FROM dx_api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.organisation_id = $1 ORDER BY k.created_at DESC`, [organisationId]);
  return rows;
}

export async function revokeKey(c: Q, organisationId: string, keyId: string, actor: string | null, ip?: string) {
  const { rows: [k] } = await c.query(
    `UPDATE dx_api_keys SET revoked_at = coalesce(revoked_at, now())
     WHERE id = $1 AND organisation_id = $2 RETURNING id, key_prefix, revoked_at`, [keyId, organisationId]);
  if (!k) throw notFound('API key');
  await recordAuthEvent(c, { event: 'api_key_revoked', subject_type: 'dx_api_key', subject_id: keyId,
    organisation_id: organisationId, actor_ref: actor ?? 'cli', source_ip: ip });
  return k;
}

export function requireSameOrg(p: ApiKeyPrincipal, orgId: string) {
  if (p.organisationId !== orgId) throw forbidden('This API key belongs to another organisation');
}
