/**
 * LIS staff sign-in: username + password per lab, then a bearer session token.
 */
import type pg from 'pg';
import type { Db } from '../db.js';
import { badRequest, forbidden, notFound, tooMany, unauthorized } from '../lis/errors.js';
import type { Staff } from '../lis/service.js';
import { hashPassword, hashToken, newSessionToken, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from './crypto.js';
import { recordAuthEvent } from './events.js';

type Q = Db | pg.PoolClient;

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export interface AuthPolicy { sessionHours: number }
export interface RequestMeta { ip?: string; userAgent?: string }

export interface Session { token: string; expires_at: string; staff: Staff & { username: string } }

export function checkNewPassword(password: string) {
  if (password.length < PASSWORD_MIN) throw badRequest(`Password must be at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) throw badRequest(`Password must be at most ${PASSWORD_MAX} characters`);
}

/** Create a session for a staff member. Returns the token; only its hash is stored. */
export async function issueSession(c: Q, labId: string, staffId: string, policy: AuthPolicy, meta: RequestMeta = {}) {
  const token = newSessionToken();
  const { rows: [s] } = await c.query<{ expires_at: Date }>(
    `INSERT INTO lis.staff_sessions (lab_id, staff_id, token_hash, expires_at, user_agent, source_ip)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6) RETURNING expires_at`,
    [labId, staffId, hashToken(token), policy.sessionHours, meta.userAgent ?? null, meta.ip ?? null]);
  return { token, expires_at: s!.expires_at.toISOString() };
}

export async function login(
  db: Db, labId: string, username: string, password: string, policy: AuthPolicy, meta: RequestMeta = {},
): Promise<Session> {
  const { rows: [u] } = await db.query<Staff & { username: string; password_hash: string | null; active: boolean;
    failed_logins: number; locked: boolean }>(
    `SELECT id, lab_id, username, full_name, role, password_hash, active, failed_logins,
            coalesce(locked_until > now(), false) AS locked
     FROM lis.staff_users WHERE lab_id = $1 AND lower(username) = lower($2)`, [labId, username]);

  // Always run the hash so unknown usernames are not faster to reject.
  const ok = await verifyPassword(password, u?.password_hash ?? null);
  const fail = { subject_type: 'lis_staff' as const, subject_id: u?.id ?? null, lab_id: labId, source_ip: meta.ip };

  if (u?.locked) {
    await recordAuthEvent(db, { ...fail, event: 'login_failed', detail: { reason: 'locked' } });
    throw tooMany(`Too many wrong passwords. Try again in ${LOCKOUT_MINUTES} minutes or ask your lab admin.`);
  }
  if (!u || !u.active || !ok) {
    if (u) {
      const { rows: [n] } = await db.query<{ failed_logins: number }>(
        `UPDATE lis.staff_users
         SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) END
         WHERE id = $1 RETURNING failed_logins`, [u.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES]);
      if (n && n.failed_logins >= MAX_FAILED_LOGINS) await recordAuthEvent(db, { ...fail, event: 'account_locked' });
    }
    await recordAuthEvent(db, { ...fail, event: 'login_failed',
      detail: { reason: !u ? 'unknown_user' : !u.active ? 'inactive' : 'bad_password', username } });
    throw unauthorized('Wrong username or password');
  }

  await db.query('UPDATE lis.staff_users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  const s = await issueSession(db, labId, u.id, policy, meta);
  await recordAuthEvent(db, { ...fail, event: 'login_succeeded' });
  return { ...s, staff: { id: u.id, lab_id: u.lab_id, username: u.username, full_name: u.full_name, role: u.role } };
}

/** The staff member behind a bearer token, for the lab in the URL. */
export async function authenticate(db: Db, labId: string, token: string | null): Promise<Staff & { session_id: string }> {
  if (!token) throw unauthorized('Sign in required: send Authorization: Bearer <session token>');
  const { rows: [s] } = await db.query<Staff & { session_id: string; stale: boolean }>(
    `SELECT s.id AS session_id, u.id, u.lab_id, u.full_name, u.role, s.last_seen_at < now() - interval '1 minute' AS stale
     FROM lis.staff_sessions s JOIN lis.staff_users u ON u.id = s.staff_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`, [hashToken(token)]);
  if (!s) throw unauthorized('Session expired or signed out. Please sign in again.');
  if (s.lab_id !== labId) throw forbidden('This session belongs to another lab');
  if (s.stale) await db.query('UPDATE lis.staff_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
  return { session_id: s.session_id, id: s.id, lab_id: s.lab_id, full_name: s.full_name, role: s.role };
}

export async function logout(db: Db, staff: Staff & { session_id: string }, meta: RequestMeta = {}) {
  await db.query('UPDATE lis.staff_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [staff.session_id]);
  await recordAuthEvent(db, { event: 'logout', subject_type: 'lis_staff', subject_id: staff.id, lab_id: staff.lab_id, source_ip: meta.ip });
}

async function storePassword(c: Q, labId: string, staffId: string, password: string, actor: string, meta: RequestMeta) {
  checkNewPassword(password);
  const hash = await hashPassword(password);
  const { rowCount } = await c.query(
    `UPDATE lis.staff_users SET password_hash = $3, password_changed_at = now(), failed_logins = 0, locked_until = NULL
     WHERE id = $1 AND lab_id = $2`, [staffId, labId, hash]);
  if (!rowCount) throw notFound('Staff member');
  await recordAuthEvent(c, { event: 'password_set', subject_type: 'lis_staff', subject_id: staffId, lab_id: labId,
    actor_ref: actor, source_ip: meta.ip });
}

/** A staff member changes their own password; their other sessions are signed out. */
export async function changeOwnPassword(
  db: Db, staff: Staff & { session_id: string }, current: string, next: string, meta: RequestMeta = {},
) {
  const { rows: [u] } = await db.query<{ password_hash: string | null }>(
    'SELECT password_hash FROM lis.staff_users WHERE id = $1', [staff.id]);
  if (!(await verifyPassword(current, u?.password_hash ?? null))) throw forbidden('Current password is wrong');
  await storePassword(db, staff.lab_id, staff.id, next, staff.id, meta);
  await db.query(
    'UPDATE lis.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND id <> $2 AND revoked_at IS NULL',
    [staff.id, staff.session_id]);
}

/** A lab admin sets (or resets) a staff member's password; all of that person's sessions are signed out. */
export async function setStaffPassword(db: Db, admin: Staff, staffId: string, password: string, meta: RequestMeta = {}) {
  if (admin.role !== 'admin') throw forbidden('Only a lab admin can set passwords for other staff');
  await storePassword(db, admin.lab_id, staffId, password, admin.id, meta);
  await db.query('UPDATE lis.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [staffId]);
}

/** Used by the command-line tool to give the first admin a password. */
export async function setPasswordByUsername(db: Db, labCode: string, username: string, password: string) {
  const { rows: [u] } = await db.query<{ id: string; lab_id: string }>(
    `SELECT u.id, u.lab_id FROM lis.staff_users u JOIN lis.labs l ON l.id = u.lab_id
     WHERE l.code = $1 AND lower(u.username) = lower($2)`, [labCode, username]);
  if (!u) throw notFound(`Staff member ${username} in lab ${labCode}`);
  await storePassword(db, u.lab_id, u.id, password, 'cli', {});
  await db.query('UPDATE lis.staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [u.id]);
  return u;
}
