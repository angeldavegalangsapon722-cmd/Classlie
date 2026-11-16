const { upcomingSessions } = require("./classTime");
const { pushConfigured, sendPush } = require("./push");

function safeTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch { return "UTC"; }
}

// Convert a wall-clock date and time in an IANA zone to its UTC instant.
function zonedInstant(date, hm, timeZone) {
  const [hour, minute] = hm.split(":").map(Number);
  const desired = Date.UTC(date.y, date.m - 1, date.d, hour, minute);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hourCycle: "h23"
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const actual = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const adjustment = desired - actual;
    if (!adjustment) break;
    guess += adjustment;
  }
  return new Date(guess);
}

async function claimDelivery(db, subscription, kind, eventKey, payload) {
  const claim = await db.query(
    `INSERT INTO push_delivery_log (subscription_id, kind, event_key)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING subscription_id`,
    [subscription.id, kind, eventKey]
  );
  if (!claim.rows.length) return false;
  const sent = await sendPush(subscription, payload);
  if (!sent) await db.query("DELETE FROM push_subscriptions WHERE id=$1", [subscription.id]);
  return sent;
}

async function runPushReminders(db) {
  if (!pushConfigured()) return { skipped: true };

  // Avoid duplicate deliveries when multiple app workers run the same periodic job.
  const lock = await db.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(1728064284) AS locked")).rows[0].locked;
    if (!locked) return { skipped: true };

    const subscriptionResult = await db.query("SELECT id, user_id, endpoint, p256dh, auth, timezone FROM push_subscriptions");
    const subscriptions = subscriptionResult.rows;
    if (!subscriptions.length) return { sent: 0 };

    const scheduleResult = await db.query(
      `SELECT ps.id AS subscription_id, s.id AS schedule_id, s.title, s.day_of_week,
              s.start_time, s.end_time, s.room, c.name AS class_name, sub.name AS subject_name
       FROM push_subscriptions ps
       JOIN class_members cm ON cm.user_id=ps.user_id
       JOIN schedules s ON s.class_id=cm.class_id
       JOIN classes c ON c.id=s.class_id
       LEFT JOIN subjects sub ON sub.id=s.subject_id`
    );
    const scheduleBySubscription = new Map();
    for (const row of scheduleResult.rows) {
      if (!scheduleBySubscription.has(row.subscription_id)) scheduleBySubscription.set(row.subscription_id, []);
      scheduleBySubscription.get(row.subscription_id).push(row);
    }

    let sent = 0;
    const now = new Date();
    const nowMs = now.getTime();
    const taskCache = new Map();
    for (const subscription of subscriptions) {
      const zone = safeTimeZone(subscription.timezone || "UTC");
      const schedules = scheduleBySubscription.get(subscription.id) || [];
      const { upcoming } = upcomingSessions(schedules, zone, now, 1000);
      for (const schedule of upcoming) {
        const startAt = zonedInstant(schedule.date, schedule.start, zone);
        const minutes = Math.ceil((startAt.getTime() - nowMs) / 60000);
        if (minutes < 0 || minutes > 15) continue;
        const dateKey = `${schedule.date.y}-${String(schedule.date.m).padStart(2, "0")}-${String(schedule.date.d).padStart(2, "0")}`;
        const subject = schedule.subject_name ? ` · ${schedule.subject_name}` : "";
        const delivered = await claimDelivery(db, subscription, "class_start", `${schedule.schedule_id}:${dateKey}`, {
          title: "Class starts soon",
          body: `${schedule.title}${subject} starts in ${Math.max(minutes, 1)} minute${minutes === 1 ? "" : "s"}${schedule.class_name ? ` (${schedule.class_name})` : ""}.`,
          tag: `class-${schedule.schedule_id}-${dateKey}`,
          url: "/"
        });
        if (delivered) sent++;
      }

      if (!taskCache.has(subscription.user_id)) {
        taskCache.set(subscription.user_id, db.query(
          `SELECT t.id, t.title, t.due_at, c.name AS class_name
           FROM tasks t
           JOIN class_members cm ON cm.class_id=t.class_id AND cm.user_id=$1
           JOIN classes c ON c.id=t.class_id
           WHERE t.due_at IS NOT NULL AND t.due_at <= NOW()
             AND (NOT t.is_private OR t.created_by=$1)
             AND NOT EXISTS (SELECT 1 FROM task_completions tc WHERE tc.task_id=t.id AND tc.user_id=$1)
           ORDER BY t.due_at ASC LIMIT 50`,
          [subscription.user_id]
        ));
      }
      const overdue = await taskCache.get(subscription.user_id);
      for (const task of overdue.rows) {
        const delivered = await claimDelivery(db, subscription, "task_overdue", task.id, {
          title: "Task overdue",
          body: `“${task.title}” is overdue${task.class_name ? ` in ${task.class_name}` : ""}.`,
          tag: `task-overdue-${task.id}`,
          url: "/"
        });
        if (delivered) sent++;
      }
    }
    return { sent };
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(1728064284)").catch(() => {});
    lock.release();
  }
}

module.exports = { runPushReminders };
