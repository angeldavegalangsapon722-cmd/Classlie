-- Classlie PostgreSQL schema
-- Run with:  npm run db:setup   (or: psql -d classlie -f db/schema.sql)
-- Safe to re-run: every statement is idempotent. Requires PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(100) NOT NULL,
  username VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  active_status BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_status BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  section VARCHAR(80),
  school VARCHAR(160),
  academic_year VARCHAR(40),
  code VARCHAR(8) NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('owner','admin','student')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (class_id, user_id)
);
ALTER TABLE class_members ADD COLUMN IF NOT EXISTS special_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_members_special_key ON class_members(class_id, special_key) WHERE special_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT '#6478F0',
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  title VARCHAR(160) NOT NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  room VARCHAR(100),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS temporary_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE TABLE IF NOT EXISTS temporary_schedule_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES temporary_schedules(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  subject VARCHAR(120),
  entry_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  room VARCHAR(100),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_temporary_schedules_class_dates ON temporary_schedules(class_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_temporary_schedule_entries_date ON temporary_schedule_entries(schedule_id, entry_date, start_time);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT,
  due_at TIMESTAMPTZ,
  priority VARCHAR(12) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Personal tasks are visible only to the student who created them.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS task_completions (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(20) NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id UUID,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('task','due_soon')),
  title VARCHAR(200) NOT NULL,
  body TEXT,
  page VARCHAR(40),
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_class_date ON activity_log(class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique ON notifications(user_id, type, entity_id) WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);
CREATE INDEX IF NOT EXISTS idx_schedules_class_day ON schedules(class_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_tasks_class_due ON tasks(class_id, due_at);
CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects(class_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_topics_subject ON topics(subject_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_schedules_subject ON schedules(subject_id);

-- Password reset requests. Only a hash of the emailed token is stored, so a database leak cannot be used to reset accounts.
CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expiry ON password_resets(expires_at);

-- Attendance: a session is either a weekly recurrence (days[] + times) or a single dated event,
-- optionally tied to a subject. "flag ceremony" = weekly Monday; "Programming 2" = weekly, subject set.
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  name VARCHAR(160) NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('weekly','date')),
  days SMALLINT[] NOT NULL DEFAULT '{}',
  event_date DATE,
  start_time TIME,
  end_time TIME,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind = 'weekly' OR event_date IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_attendance_sessions_class ON attendance_sessions(class_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurred_on DATE NOT NULL,
  status VARCHAR(10) NOT NULL CHECK (status IN ('present','absent','late','excused')),
  marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id, occurred_on)
);
CREATE INDEX IF NOT EXISTS idx_attendance_records_user ON attendance_records(user_id, occurred_on DESC);

-- Student-uploaded notes/attachments. Files are kept in the database (bytea) so a single database backup keeps everything.
CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  file_data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uploads_class ON uploads(class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_subject ON uploads(subject_id);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

-- Shared notes can be typed, uploaded, or generated by AI. "source" drives the little AI badge.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'manual';

-- Reviewer notes can be typed by hand or generated by AI from an uploaded file. "source" records which.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS source VARCHAR(12) NOT NULL DEFAULT 'manual';

-- Reviewers now live directly under a subject (the Subject -> Topic -> Note drill-down was too many taps).
-- topic_id stays for backward compatibility but is optional; subject_id is the real parent.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS subject_id UUID REFERENCES subjects(id) ON DELETE CASCADE;
ALTER TABLE notes ALTER COLUMN topic_id DROP NOT NULL;
UPDATE notes SET subject_id = t.subject_id FROM topics t WHERE notes.topic_id = t.id AND notes.subject_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject_id, updated_at DESC);

-- AI-generated multiple-choice quizzes. Questions are stored as a JSON array so the exact
-- presentation (options order, explanations) is preserved without extra tables.
CREATE TABLE IF NOT EXISTS quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES subjects(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  difficulty VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quizzes_class ON quizzes(class_id, created_at DESC);

-- One row per attempt, so a quiz can be retaken and progress tracked. Answers store the choice
-- index the student picked for each question, for later review.
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  answers JSONB NOT NULL DEFAULT '[]'::jsonb,
  incorrect_indices JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS incorrect_indices JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id, created_at DESC);

-- Per-question quiz review schedule. Misses return after three days; correct reviews grow the interval.
CREATE TABLE IF NOT EXISTS quiz_question_reviews (
  quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL CHECK (question_index >= 0),
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '3 days',
  interval_days REAL NOT NULL DEFAULT 3,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 1,
  last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quiz_id, user_id, question_index)
);
CREATE INDEX IF NOT EXISTS idx_quiz_question_reviews_due ON quiz_question_reviews(user_id, due_at);

-- A personal, AI-generated study plan for the week. One per member per class.
CREATE TABLE IF NOT EXISTS study_plans (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL DEFAULT '',
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, class_id)
);

-- Product analytics: a small, fixed set of activation events (class created, first task, AI used…)
-- used to understand where new students drop off. Purely additive.
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  props JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_name_date ON events(name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at DESC);

-- Web push subscriptions (one row per browser/device a user opted in from).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS push_delivery_log (
  subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,
  event_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, kind, event_key)
);
