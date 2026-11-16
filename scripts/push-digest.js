// Daily push digest: for every push subscription, send a short summary of what's
// due today or tomorrow. Safe to run on a schedule (e.g. cron at 7am) or by hand.
// No-ops when VAPID keys aren't configured, and prunes subscriptions the browser
// has thrown away (404/410).
require("dotenv").config();
const { createPool } = require("../src/db");
const { pushConfigured, sendPush } = require("../src/push");

(async () => {
  if (!pushConfigured()) {
    console.log("Web push is not configured (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Nothing to do.");
    return;
  }
  const pool = createPool();
  try {
    const subs = await pool.query("SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions");
    let sent = 0, pruned = 0;
    for (const sub of subs.rows) {
      const due = await pool.query(
        `SELECT t.title, t.due_at, c.name AS class_name
         FROM tasks t
         JOIN class_members cm ON cm.class_id = t.class_id AND cm.user_id = $1
         JOIN classes c ON c.id = t.class_id
         WHERE t.due_at IS NOT NULL AND t.due_at <= NOW() + INTERVAL '24 hours' AND t.due_at > NOW()
           AND NOT EXISTS (SELECT 1 FROM task_completions tc WHERE tc.task_id = t.id AND tc.user_id = $1)
         ORDER BY t.due_at LIMIT 5`,
        [sub.user_id]
      );
      if (!due.rows.length) continue;
      const body = due.rows.length === 1
        ? `“${due.rows[0].title}” is due soon.`
        : `${due.rows.length} tasks are due in the next 24 hours, starting with “${due.rows[0].title}”.`;
      const ok = await sendPush(sub, { title: "Classlie · Due soon", body, tag: "due-soon", url: "/" });
      if (ok) sent++; else { await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [sub.id]); pruned++; }
    }
    console.log(`Push digest sent to ${sent} subscription(s)${pruned ? `, pruned ${pruned} expired` : ""}.`);
  } catch (error) {
    console.error("Push digest failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
