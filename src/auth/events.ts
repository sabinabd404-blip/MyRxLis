export interface Q { query: (sql: string, params?: unknown[]) => Promise<unknown> }

export interface AuthEvent {
  event: 'login_succeeded' | 'login_failed' | 'account_locked' | 'logout' | 'password_set'
    | 'api_key_created' | 'api_key_revoked' | 'api_key_rejected';
  subject_type: 'lis_staff' | 'dx_user' | 'dx_api_key' | 'unknown';
  subject_id?: string | null;
  lab_id?: string | null;
  organisation_id?: string | null;
  actor_ref?: string | null;
  source_ip?: string | null;
  detail?: object;
}

/** Record a sign-in or credential event (append-only). */
export async function recordAuthEvent(c: Q, e: AuthEvent): Promise<void> {
  await c.query(
    `INSERT INTO auth_events (event, subject_type, subject_id, lab_id, organisation_id, actor_ref, source_ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.event, e.subject_type, e.subject_id ?? null, e.lab_id ?? null, e.organisation_id ?? null,
      e.actor_ref ?? null, e.source_ip ?? null, e.detail ?? {}]);
}
