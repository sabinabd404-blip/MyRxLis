-- ============================================================
-- Real authentication, replacing the x-staff-id / x-dx-user headers.
--
--   * LIS staff sign in with username + password and get a session token
--     (Authorization: Bearer ...). Passwords are stored as scrypt hashes.
--   * Systems that talk to MyRx DX (the MyRx EMR, a lab's own LIS) use an
--     API key issued to a user in one organisation, normally an
--     integration_service user.
--
-- Only SHA-256 hashes of tokens and keys are stored, never the values.
-- ============================================================

-- Lock-out after repeated wrong passwords.
ALTER TABLE lis.staff_users
    ADD COLUMN failed_logins       integer NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
    ADD COLUMN locked_until        timestamptz,
    ADD COLUMN password_changed_at timestamptz;

CREATE TABLE lis.staff_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lab_id       uuid NOT NULL,
    staff_id     uuid NOT NULL,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    user_agent   text,
    source_ip    inet,
    CHECK (expires_at > created_at),
    FOREIGN KEY (staff_id, lab_id) REFERENCES lis.staff_users (id, lab_id)
);
CREATE INDEX staff_sessions_staff_idx ON lis.staff_sessions (staff_id) WHERE revoked_at IS NULL;

CREATE TABLE dx_api_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES organisations(id),
    user_id         uuid NOT NULL REFERENCES users(id),
    name            text NOT NULL CHECK (length(trim(name)) > 0),
    key_prefix      text NOT NULL UNIQUE,      -- shown in lists so people can tell keys apart
    key_hash        bytea NOT NULL UNIQUE,
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX dx_api_keys_org_idx ON dx_api_keys (organisation_id);

-- A revoked key stays revoked, and a key cannot be moved to another user or organisation.
CREATE FUNCTION dx_protect_api_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'API keys are revoked, not deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.organisation_id <> OLD.organisation_id OR NEW.user_id <> OLD.user_id
       OR NEW.key_hash <> OLD.key_hash OR NEW.key_prefix <> OLD.key_prefix THEN
        RAISE EXCEPTION 'An API key cannot be reassigned' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'A revoked API key cannot be restored' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_dx_protect_api_keys BEFORE UPDATE OR DELETE ON dx_api_keys
    FOR EACH ROW EXECUTE FUNCTION dx_protect_api_keys();

-- Sign-in and credential events for both LIS and DX, append-only.
CREATE TABLE auth_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    event        text NOT NULL CHECK (event IN (
                    'login_succeeded', 'login_failed', 'account_locked', 'logout',
                    'password_set', 'api_key_created', 'api_key_revoked', 'api_key_rejected')),
    subject_type text NOT NULL CHECK (subject_type IN ('lis_staff', 'dx_user', 'dx_api_key', 'unknown')),
    subject_id   uuid,
    lab_id       uuid,
    organisation_id uuid,
    actor_ref    text,
    source_ip    inet,
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX auth_events_subject_idx ON auth_events (subject_type, subject_id, at DESC);

CREATE FUNCTION auth_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Auth events are append-only' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER trg_auth_events_append_only BEFORE UPDATE OR DELETE ON auth_events
    FOR EACH ROW EXECUTE FUNCTION auth_events_append_only();
