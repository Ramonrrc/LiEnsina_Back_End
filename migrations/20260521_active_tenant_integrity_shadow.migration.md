-- Active pre-production tenant-integrity guard for the current collection store.
-- The application creates and refreshes these tables transactionally on each
-- PostgreSQL persist. They are deliberately shadow tables while the final
-- normalized read/write migration is prepared, but the foreign keys and unique
-- indexes below already make cross-school data invalid at database commit time.

CREATE TABLE IF NOT EXISTS store_meta (
  name text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO store_meta (name, revision, updated_at)
VALUES ('collections', 0, now())
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_schools_rel (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS tenant_users_rel (
  id text PRIMARY KEY,
  school_id text NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  role_code text NOT NULL CHECK (role_code IN ('ADMIN','DIRETOR','COORDENADOR','PROFESSOR','ALUNO','RESPONSAVEL','NUTRITIONIST')),
  status text NOT NULL CHECK (status IN ('ativo','pendente','bloqueado')),
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_teachers_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES tenant_users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_classes_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  teacher_id text NULL,
  academic_year integer NOT NULL,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, teacher_id) REFERENCES tenant_teachers_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_class_teachers_rel (
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  class_id text NOT NULL,
  teacher_id text NOT NULL,
  PRIMARY KEY (school_id, class_id, teacher_id),
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, teacher_id) REFERENCES tenant_teachers_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_students_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES tenant_users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  class_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('matriculado','transferido','inativo')),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_guardians_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES tenant_users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS tenant_guardian_students_rel (
  guardian_id text NOT NULL,
  student_id text NOT NULL,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  PRIMARY KEY (guardian_id, student_id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES tenant_guardians_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, student_id) REFERENCES tenant_students_rel(school_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_subjects_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  name text NOT NULL,
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS tenant_teacher_assignments_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  teacher_id text NOT NULL,
  class_id text NOT NULL,
  subject_id text NOT NULL,
  UNIQUE (teacher_id, school_id, class_id, subject_id),
  FOREIGN KEY (school_id, teacher_id) REFERENCES tenant_teachers_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, subject_id) REFERENCES tenant_subjects_rel(school_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tenant_evaluations_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  class_id text NOT NULL,
  teacher_id text NULL,
  subject_id text NULL,
  idempotency_key text NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (school_id, id),
  UNIQUE (school_id, teacher_id, idempotency_key),
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, teacher_id) REFERENCES tenant_teachers_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, subject_id) REFERENCES tenant_subjects_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenant_answer_cards_rel (
  id text PRIMARY KEY,
  card_id text NOT NULL UNIQUE,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  evaluation_id text NOT NULL,
  class_id text NOT NULL,
  student_id text NOT NULL,
  status text NOT NULL,
  FOREIGN KEY (school_id, evaluation_id) REFERENCES tenant_evaluations_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, student_id) REFERENCES tenant_students_rel(school_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_answer_cards_active_unique
  ON tenant_answer_cards_rel (school_id, evaluation_id, student_id)
  WHERE status <> 'CANCELLED';

CREATE TABLE IF NOT EXISTS tenant_evaluation_corrections_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES tenant_schools_rel(id) ON DELETE RESTRICT,
  evaluation_id text NOT NULL,
  class_id text NOT NULL,
  student_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (school_id, evaluation_id, student_id),
  FOREIGN KEY (school_id, evaluation_id) REFERENCES tenant_evaluations_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES tenant_classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, student_id) REFERENCES tenant_students_rel(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tenant_users_school_idx ON tenant_users_rel(school_id);
CREATE INDEX IF NOT EXISTS tenant_students_school_class_idx ON tenant_students_rel(school_id, class_id);
CREATE INDEX IF NOT EXISTS tenant_evaluations_school_class_idx ON tenant_evaluations_rel(school_id, class_id);
CREATE INDEX IF NOT EXISTS tenant_corrections_school_eval_idx ON tenant_evaluation_corrections_rel(school_id, evaluation_id);
