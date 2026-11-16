const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { requireClassMember, requireClassAdmin } = require("../middleware/classAccess");
const { badRequest } = require("../middleware/errors");
const { isUuid, uuidParams, cleanText } = require("../middleware/validate");
const { logActivity } = require("../activity");

router.use(requireAuth);
uuidParams(router, "classId", "id");

const STATUSES = ["present", "absent", "late", "excused"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const normalizeTime = (v) => (v.length === 5 ? `${v}:00` : v);

function parseDate(label) {
  return (value) => {
    if (typeof value !== "string" || !DATE_RE.test(value.trim())) throw badRequest(`${label} must be a date like 2026-08-17.`);
    const d = new Date(`${value.trim()}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw badRequest(`${label} is not a valid date.`);
    return value.trim();
  };
}
function parseOptionalTime(label) {
  return (value) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !TIME_RE.test(value.trim())) throw badRequest(`${label} must be a time like 07:30.`);
    return normalizeTime(value.trim());
  };
}

function sessionFields(body, { partial = false } = {}) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  if (!partial || input.name !== undefined) out.name = cleanText(input.name, "Session name", 160, { required: true });
  if (!partial || input.subject_id !== undefined) {
    out.subject_id = input.subject_id ? (isUuid(input.subject_id) ? input.subject_id : (() => { throw badRequest("Subject is not valid."); })()) : null;
  }
  if (!partial || input.kind !== undefined) {
    if (!["weekly", "date"].includes(input.kind)) throw badRequest("Choose whether this repeats weekly or happens on one date.");
    out.kind = input.kind;
  }
  const kind = out.kind || input.kind;
  if (kind === "weekly") {
    const days = Array.isArray(input.days) ? input.days : [];
    const clean = [...new Set(days.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort((a, b) => a - b);
    if (!clean.length) throw badRequest("Pick at least one day of the week.");
    out.days = clean;
    out.event_date = null;
  } else if (kind === "date") {
    out.event_date = parseDate("Date")(input.event_date);
    out.days = [];
  }
  if (!partial || input.start_time !== undefined || input.end_time !== undefined) {
    out.start_time = parseOptionalTime("Start time")(input.start_time);
    out.end_time = parseOptionalTime("End time")(input.end_time);
  }
  return out;
}

async function assertSubjectInClass(db, subjectId, classId) {
  if (!subjectId) return;
  const found = await db.query("SELECT 1 FROM subjects WHERE id=$1 AND class_id=$2", [subjectId, classId]);
  if (!found.rowCount) throw badRequest("That subject does not belong to this class.");
}

// Does a session actually happen on a given date?
function occursOn(session, date) {
  if (session.kind === "date") return String(session.event_date).slice(0, 10) === date;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return Array.isArray(session.days) && session.days.map(Number).includes(weekday);
}

router.get("/:classId/sessions", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT s.*, sub.name AS subject_name,
        (SELECT COUNT(*)::int FROM attendance_records r WHERE r.session_id = s.id) AS record_count
       FROM attendance_sessions s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       WHERE s.class_id = $1
       ORDER BY s.kind, s.name`,
      [req.params.classId]
    );
    res.json({ sessions: result.rows });
  } catch (error) { next(error); }
});

// Sessions scheduled for one specific day (used to build a quick "take attendance" screen).
router.get("/:classId/day", requireClassMember, async (req, res, next) => {
  try {
    const date = parseDate("Date")(req.query.date);
    const result = await req.app.locals.db.query("SELECT * FROM attendance_sessions WHERE class_id=$1", [req.params.classId]);
    const sessions = result.rows.filter((s) => occursOn(s, date));
    res.json({ date, sessions });
  } catch (error) { next(error); }
});

router.post("/:classId/sessions", requireClassAdmin, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const values = sessionFields(req.body, { partial: false });
    await assertSubjectInClass(db, values.subject_id, req.params.classId);
    values.class_id = req.params.classId;
    values.created_by = req.user.id;
    const cols = Object.keys(values);
    const result = await db.query(
      `INSERT INTO attendance_sessions (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      Object.values(values)
    );
    const session = result.rows[0];
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "attendance", entityId: session.id, summary: `added attendance “${session.name}”` });
    res.status(201).json({ session });
  } catch (error) { next(error); }
});

router.patch("/:classId/sessions/:id", requireClassAdmin, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const existing = (await db.query("SELECT * FROM attendance_sessions WHERE id=$1 AND class_id=$2", [req.params.id, req.params.classId])).rows[0];
    if (!existing) return res.status(404).json({ error: "Attendance session not found." });
    const merged = { ...existing, ...req.body };
    const values = sessionFields(merged, { partial: false });
    await assertSubjectInClass(db, values.subject_id, req.params.classId);
    const cols = Object.keys(values);
    const result = await db.query(
      `UPDATE attendance_sessions SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")} WHERE id=$${cols.length + 1} AND class_id=$${cols.length + 2} RETURNING *`,
      [...Object.values(values), req.params.id, req.params.classId]
    );
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "attendance", entityId: req.params.id, summary: `updated attendance “${result.rows[0].name}”` });
    res.json({ session: result.rows[0] });
  } catch (error) { next(error); }
});

router.delete("/:classId/sessions/:id", requireClassAdmin, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      "DELETE FROM attendance_sessions WHERE id=$1 AND class_id=$2 RETURNING name",
      [req.params.id, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Attendance session not found." });
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "delete", entityType: "attendance", entityId: req.params.id, summary: `deleted attendance “${result.rows[0].name}”` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// The roster for one date, with each member's current status (null = not yet marked).
router.get("/:classId/sessions/:id", requireClassMember, async (req, res, next) => {
  try {
    const date = parseDate("Date")(req.query.date);
    const db = req.app.locals.db;
    const session = (await db.query(
      `SELECT s.*, sub.name AS subject_name FROM attendance_sessions s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       WHERE s.id=$1 AND s.class_id=$2`,
      [req.params.id, req.params.classId]
    )).rows[0];
    if (!session) return res.status(404).json({ error: "Attendance session not found." });
    const rows = (await db.query(
      `SELECT u.id, u.full_name, u.username, cm.role, r.status, r.marked_at
       FROM class_members cm JOIN users u ON u.id = cm.user_id
       LEFT JOIN attendance_records r ON r.session_id=$1 AND r.user_id=u.id AND r.occurred_on=$2
       WHERE cm.class_id=$3
       ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.full_name`,
      [req.params.id, date, req.params.classId]
    )).rows;
    const canMark = ["owner", "admin"].includes(req.membership.role);
    res.json({ session, date, occurs: occursOn(session, date), members: rows, canMark });
  } catch (error) { next(error); }
});

// Save the whole roster for a date in one request.
router.put("/:classId/sessions/:id/records", requireClassAdmin, async (req, res, next) => {
  const client = await req.app.locals.db.connect();
  try {
    const date = parseDate("Date")(req.body?.date);
    const session = (await client.query("SELECT * FROM attendance_sessions WHERE id=$1 AND class_id=$2", [req.params.id, req.params.classId])).rows[0];
    if (!session) return res.status(404).json({ error: "Attendance session not found." });
    if (!occursOn(session, date)) throw badRequest("This session does not happen on that date.");
    const payload = Array.isArray(req.body?.records) ? req.body.records : [];
    const memberCheck = await client.query("SELECT user_id FROM class_members WHERE class_id=$1", [req.params.classId]);
    const validUsers = new Set(memberCheck.rows.map((r) => r.user_id));

    await client.query("BEGIN");
    for (const entry of payload) {
      if (!entry || !isUuid(entry.userId)) throw badRequest("One of the members is not valid.");
      if (!validUsers.has(entry.userId)) throw badRequest("That member is not in this class.");
      const status = entry.status === "" || entry.status === undefined || entry.status === null ? null : entry.status;
      if (status === null) {
        await client.query("DELETE FROM attendance_records WHERE session_id=$1 AND user_id=$2 AND occurred_on=$3", [req.params.id, entry.userId, date]);
        continue;
      }
      if (!STATUSES.includes(status)) throw badRequest("Status must be present, absent, late, or excused.");
      await client.query(
        `INSERT INTO attendance_records (session_id, user_id, occurred_on, status, marked_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (session_id, user_id, occurred_on)
         DO UPDATE SET status=EXCLUDED.status, marked_by=EXCLUDED.marked_by, marked_at=NOW()`,
        [req.params.id, entry.userId, date, status, req.user.id]
      );
    }
    await client.query("COMMIT");
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "attendance", entityId: req.params.id, summary: `took attendance for “${session.name}” on ${date}` });
    res.json({ ok: true, date });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// Attendance analytics: a member's rate overall and per subject.
// Students see their own; admins may pass ?userId=<member> to view anyone in the class.
router.get("/:classId/attendance/summary", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const isAdminRole = ["owner", "admin"].includes(req.membership.role);
    let userId = req.user.id;
    if (req.query.userId && isUuid(req.query.userId)) {
      if (!isAdminRole && req.query.userId !== req.user.id) return res.status(403).json({ error: "Only admins can view another member's attendance." });
      userId = req.query.userId;
    }
    const member = (await db.query(
      "SELECT u.id, u.full_name FROM class_members cm JOIN users u ON u.id = cm.user_id WHERE cm.class_id=$1 AND cm.user_id=$2",
      [req.params.classId, userId]
    )).rows[0];
    if (!member) return res.status(404).json({ error: "That member is not in this class." });
    const rows = (await db.query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name, r.status, COUNT(*)::int AS n
       FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       WHERE s.class_id = $1 AND r.user_id = $2
       GROUP BY sub.id, sub.name, r.status`,
      [req.params.classId, userId]
    )).rows;
    const blank = () => ({ present: 0, late: 0, absent: 0, excused: 0 });
    // Attended = present + late. Excused is set aside (neither helps nor hurts); absent counts against.
    const finalize = (counts) => {
      const counted = counts.present + counts.late + counts.absent;
      const attended = counts.present + counts.late;
      return { ...counts, total: counts.present + counts.late + counts.absent + counts.excused, counted, attended, rate: counted ? Math.round((attended / counted) * 100) : null };
    };
    const overall = blank();
    const bySubject = new Map();
    const UNASSIGNED = "__none__";
    for (const r of rows) {
      overall[r.status] = (overall[r.status] || 0) + r.n;
      const key = r.subject_id || UNASSIGNED;
      if (!bySubject.has(key)) bySubject.set(key, { subject_id: r.subject_id, subject_name: r.subject_name, ...blank() });
      bySubject.get(key)[r.status] = (bySubject.get(key)[r.status] || 0) + r.n;
    }
    const subjects = [...bySubject.values()]
      .map((s) => ({ subject_id: s.subject_id, subject_name: s.subject_name || "No subject", ...finalize(s) }))
      .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101));
    res.json({ member: { id: member.id, full_name: member.full_name }, overall: finalize(overall), subjects });
  } catch (error) { next(error); }
});

module.exports = router;
