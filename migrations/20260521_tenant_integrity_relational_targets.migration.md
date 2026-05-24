-- LiEnsina pre-production tenant integrity target schema.
-- This migration is intentionally additive: it creates relational target tables
-- and constraints for the next data migration from JSON collections.
-- Run only after a reviewed data backfill script maps current collection IDs.

CREATE TABLE IF NOT EXISTS schools_rel (
  id text PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS users_rel (
  id text PRIMARY KEY,
  school_id text NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  role_code text NOT NULL CHECK (role_code IN ('ADMIN','DIRETOR','COORDENADOR','PROFESSOR','ALUNO','RESPONSAVEL','NUTRITIONIST')),
  status text NOT NULL CHECK (status IN ('ativo','pendente','bloqueado'))
);

CREATE TABLE IF NOT EXISTS teachers_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS classes_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  teacher_id text NOT NULL,
  academic_year integer NOT NULL,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, teacher_id) REFERENCES teachers_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS students_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  class_id text NOT NULL,
  status text NOT NULL,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES classes_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS guardians_rel (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users_rel(id) ON DELETE RESTRICT,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);

CREATE TABLE IF NOT EXISTS guardian_students_rel (
  guardian_id text NOT NULL,
  student_id text NOT NULL,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  PRIMARY KEY (guardian_id, student_id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, student_id) REFERENCES students_rel(school_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subjects_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  name text NOT NULL,
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS teacher_assignments_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  teacher_id text NOT NULL,
  class_id text NOT NULL,
  subject_id text NOT NULL,
  UNIQUE (teacher_id, school_id, class_id, subject_id),
  FOREIGN KEY (school_id, teacher_id) REFERENCES teachers_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES classes_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects_rel(school_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evaluations_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  class_id text NOT NULL,
  teacher_id text NOT NULL,
  subject_id text NULL,
  idempotency_key text NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (school_id, id),
  UNIQUE (school_id, teacher_id, idempotency_key),
  FOREIGN KEY (school_id, class_id) REFERENCES classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, teacher_id) REFERENCES teachers_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, subject_id) REFERENCES subjects_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS answer_cards_rel (
  id text PRIMARY KEY,
  card_id text NOT NULL UNIQUE,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  evaluation_id text NOT NULL,
  class_id text NOT NULL,
  student_id text NOT NULL,
  status text NOT NULL,
  UNIQUE (school_id, evaluation_id, student_id) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (school_id, evaluation_id) REFERENCES evaluations_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, student_id) REFERENCES students_rel(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_corrections_rel (
  id text PRIMARY KEY,
  school_id text NOT NULL REFERENCES schools_rel(id) ON DELETE RESTRICT,
  evaluation_id text NOT NULL,
  class_id text NOT NULL,
  student_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (school_id, evaluation_id, student_id),
  FOREIGN KEY (school_id, evaluation_id) REFERENCES evaluations_rel(school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, class_id) REFERENCES classes_rel(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, student_id) REFERENCES students_rel(school_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS users_rel_school_idx ON users_rel(school_id);
CREATE INDEX IF NOT EXISTS students_rel_school_class_idx ON students_rel(school_id, class_id);
CREATE INDEX IF NOT EXISTS evaluations_rel_school_class_idx ON evaluations_rel(school_id, class_id);
CREATE INDEX IF NOT EXISTS corrections_rel_school_eval_idx ON evaluation_corrections_rel(school_id, evaluation_id);

-- Production recommendation after backfill:
-- ALTER TABLE users_rel ENABLE ROW LEVEL SECURITY;
-- Repeat RLS per tenant table and set app.current_school_id per request transaction.
