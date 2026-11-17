require("dotenv").config();
const { createPool } = require("./src/db");
const { createApp } = require("./src/app");
const { runPushReminders } = require("./src/pushReminders");

const jwtSecret = (process.env.JWT_SECRET || "").trim();
if (jwtSecret.length < 32 || /^(change_me|replace_this)/i.test(jwtSecret)) {
  console.error("JWT_SECRET must be set to a random string of at least 32 characters. See .env.example.");
  process.exit(1);
}

const pool = createPool();
const app = createApp(pool);
const port = Number(process.env.PORT || 3000);
let server;
pool.query("ALTER TABLE class_members ADD COLUMN IF NOT EXISTS special_key TEXT")
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS temporary_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date >= start_date)
  )`))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS temporary_schedule_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), schedule_id UUID NOT NULL REFERENCES temporary_schedules(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL, subject VARCHAR(120), entry_date DATE NOT NULL, start_time TIME NOT NULL,
    end_time TIME NOT NULL, room VARCHAR(100), CHECK (end_time > start_time)
  )`))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_temporary_schedules_class_dates ON temporary_schedules(class_id, start_date, end_date)"))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_temporary_schedule_entries_date ON temporary_schedule_entries(schedule_id, entry_date, start_time)"))
  .then(() => pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_class_members_special_key ON class_members(class_id, special_key) WHERE special_key IS NOT NULL"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)"))
  .then(() => pool.query("ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS push_delivery_log (
    subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    kind VARCHAR(32) NOT NULL,
    event_key TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subscription_id, kind, event_key)
  )`))
  .then(() => pool.query("ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS incorrect_indices JSONB NOT NULL DEFAULT '[]'::jsonb"))
  .then(() => pool.query(`CREATE TABLE IF NOT EXISTS quiz_question_reviews (
    quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_index INTEGER NOT NULL CHECK (question_index >= 0),
    due_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '3 days',
    interval_days REAL NOT NULL DEFAULT 3,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 1,
    last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (quiz_id, user_id, question_index)
  )`))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_quiz_question_reviews_due ON quiz_question_reviews(user_id, due_at)"))
  .then(() => {
    server = app.listen(port, () => console.log(`Classlie running at http://localhost:${port}`));
    const reminders = () => runPushReminders(pool).catch((error) => console.error("Push reminder job failed:", error.message));
    reminders();
    const reminderTimer = setInterval(reminders, 60_000);
    reminderTimer.unref();
  })
  .catch(async (error) => {
    console.error("Database update failed:", error.message);
    await pool.end();
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
}
