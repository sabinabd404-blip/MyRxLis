import { createKey } from '../../src/auth/dx-auth.js';
import { issueSession } from '../../src/auth/lis-auth.js';
import { pool } from './db.js';

const sessions = new Map<string, string>();
const apiKeys = new Map<string, string>();

/** `Authorization` header for a staff member, signing them in once (no password needed in tests). */
export async function staffAuth(labId: string, staffId: string) {
  let token = sessions.get(staffId);
  if (!token) {
    token = (await issueSession(pool, labId, staffId, { sessionHours: 1 })).token;
    sessions.set(staffId, token);
  }
  return { authorization: `Bearer ${token}` };
}

/**
 * `Authorization` header with a DX API key for a user. The key is issued in the
 * user's own organisation, so calling another organisation's URL with it is refused.
 */
export async function dxAuth(userId: string) {
  let key = apiKeys.get(userId);
  if (!key) {
    const { rows: [m] } = await pool.query<{ organisation_id: string }>(
      'SELECT organisation_id FROM organisation_memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1', [userId]);
    key = (await createKey(pool, m!.organisation_id, { user_id: userId, name: 'test' }, null)).key;
    apiKeys.set(userId, key);
  }
  return { authorization: `Bearer ${key}` };
}
