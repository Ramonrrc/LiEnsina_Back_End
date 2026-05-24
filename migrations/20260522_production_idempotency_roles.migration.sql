BEGIN;

ALTER TABLE IF EXISTS tenant_users_rel
  DROP CONSTRAINT IF EXISTS tenant_users_rel_role_code_check;

ALTER TABLE IF EXISTS tenant_users_rel
  ADD CONSTRAINT tenant_users_rel_role_code_check
  CHECK (role_code IN ('SUPERADMIN','ADMIN','ADMIN_ESCOLA','DIRETOR','COORDENADOR','PROFESSOR','ALUNO','RESPONSAVEL','NUTRITIONIST'));

CREATE TABLE IF NOT EXISTS idempotency_records_rel (
  scope_key text PRIMARY KEY,
  key text NOT NULL,
  actor_id text NOT NULL,
  school_id text NULL,
  operation text NOT NULL,
  resource_id text NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING','COMPLETED','FAILED','CANCELLED')),
  response jsonb NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  locked_until timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idempotency_records_actor_operation_idx
  ON idempotency_records_rel(actor_id, operation, resource_id);

CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx
  ON idempotency_records_rel(expires_at);

COMMIT;
