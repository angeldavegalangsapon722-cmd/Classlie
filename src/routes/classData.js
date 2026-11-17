const router = require("express").Router();
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { requireClassMember, requireClassAdmin } = require("../middleware/classAccess");
const { badRequest } = require("../middleware/errors");
const { isUuid, uuidParams, cleanText } = require("../middleware/validate");
const { logActivity } = require("../activity");
const { notifyClass } = require("../notify");
const { scanSchedule } = require("../gemini");

router.use(requireAuth);
uuidParams(router, "classId", "id", "taskId", "subjectId", "topicId", "noteId");

// ---- field parsers: every value is type-checked, trimmed and length-limited before it reaches SQL ----
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const normalizeTime = (v) => (v.length === 5 ? `${v}:00` : v);

function parseTime(label) {
  return (v) => {
    if (typeof v !== "string" || !TIME_RE.test(v.trim())) throw badRequest(`${label} must be a time like 08:30.`);
    return normalizeTime(v.trim());
  };
}
function parseSubjectId(v) {
  if (v === undefined || v === null || v === "") return null;
  if (!isUuid(v)) throw badRequest("Subject is not valid.");
  return v;
}
function parseOptionalText(label, max) {
  return (v) => cleanText(v, label, max) || null;
}

// ---- AI schedule import: turn loose model output into safe, validated values ----
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // 5 MB
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SCAN_BYTES, files: 1 } });
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseDay(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 6 ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if (/^[0-6]$/.test(t)) return Number(t);
  const index = DAY_NAMES.findIndex((d) => d === t || d.startsWith(t) || t.startsWith(d));
  return index === -1 ? null : index;
}

function parseClock(value) {
  if (typeof value !== "string") return null;
  const meridiem = /\b(AM|PM)\b/.exec(value.toUpperCase())?.[1] || null;
  const digits = value.trim().toUpperCase().replace(/\./g, "").replace(/\b(AM|PM)\b/, "").trim();
  const match = /^(\d{1,2})(?::(\d{2}))?/.exec(digits);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeScannedEntry(raw) {
  const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 160) : "";
  const subject = typeof raw?.subject === "string" && raw.subject.trim() ? raw.subject.trim().slice(0, 120) : title;
  return {
    title: title || subject,
    subject,
    day: parseDay(raw?.day),
    start_time: parseClock(raw?.start_time),
    end_time: parseClock(raw?.end_time),
    room: typeof raw?.room === "string" && raw.room.trim() ? raw.room.trim().slice(0, 100) : ""
  };
}

const resources = {
  subjects: {
    table: "subjects",
    order: "created_at DESC",
    required: ["name"],
    fields: {
      name: (v) => cleanText(v, "Name", 120, { required: true }),
      color: (v) => {
        if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest("Color must be a hex value like #6568e8.");
        return v.toLowerCase();
      }
    }
  },
  schedules: {
    table: "schedules",
    order: "day_of_week, start_time",
    required: ["title", "day_of_week", "start_time", "end_time"],
    fields: {
      subject_id: parseSubjectId,
      title: (v) => cleanText(v, "Title", 160, { required: true }),
      day_of_week: (v) => {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (!Number.isInteger(n) || n < 0 || n > 6) throw badRequest("Day must be between Sunday and Saturday.");
        return n;
      },
      start_time: parseTime("Start time"),
      end_time: parseTime("End time"),
      room: parseOptionalText("Room", 100)
    }
  },
  tasks: {
    table: "tasks",
    order: "due_at NULLS LAST, created_at DESC",
    required: ["title"],
    fields: {
      subject_id: parseSubjectId,
      title: (v) => cleanText(v, "Title", 180, { required: true }),
      description: parseOptionalText("Description", 5000),
      due_at: (v) => {
        if (v === undefined || v === null || v === "") return null;
        const d = new Date(v);
        if (typeof v !== "string" || Number.isNaN(d.getTime())) throw badRequest("Due date is not valid.");
        return d.toISOString();
      },
      priority: (v) => {
        if (!["low", "normal", "high"].includes(v)) throw badRequest("Priority must be low, normal, or high.");
        return v;
      }
    }
  }
};

function parseResource(cfg, body, { partial }) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  for (const [name, parse] of Object.entries(cfg.fields)) {
    if (Object.prototype.hasOwnProperty.call(input, name)) out[name] = parse(input[name]);
  }
  if (!partial) {
    for (const name of cfg.required) {
      if (out[name] === undefined || out[name] === null) throw badRequest(`${name.replace(/_/g, " ")} is required.`);
    }
  }
  return out;
}

async function assertSubjectInClass(db, subjectId, classId) {
  if (!subjectId) return;
  const found = await db.query("SELECT 1 FROM subjects WHERE id=$1 AND class_id=$2", [subjectId, classId]);
  if (!found.rowCount) throw badRequest("That subject does not belong to this class.");
}

function resourceFor(req, res) {
  const cfg = Object.prototype.hasOwnProperty.call(resources, req.params.resource) ? resources[req.params.resource] : null;
  if (!cfg) res.status(404).json({ error: "Unknown class resource." });
  return cfg;
}

const singular = { subjects: "subject", schedules: "schedule", tasks: "task" };
const itemName = (item) => item.title || item.name || "item";

const TASK_REPEAT_COUNTS = { none: 1, weekly: 15, biweekly: 8, monthly: 4 };
function recurringDueAt(firstDueAt, repeat, occurrence) {
  const first = new Date(firstDueAt);
  if (repeat === "weekly" || repeat === "biweekly") {
    const next = new Date(first);
    next.setUTCDate(next.getUTCDate() + occurrence * (repeat === "weekly" ? 7 : 14));
    return next.toISOString();
  }
  const targetMonth = first.getUTCMonth() + occurrence;
  const year = first.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = targetMonth % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(first.getUTCDate(), lastDay), first.getUTCHours(), first.getUTCMinutes(), first.getUTCSeconds(), first.getUTCMilliseconds())).toISOString();
}

async function createTaskInstances(db, { classId, userId, values, isPrivate, repeat = "none" }) {
  if (!Object.hasOwn(TASK_REPEAT_COUNTS, repeat)) throw badRequest("Repeat must be none, weekly, bi-weekly, or monthly.");
  const count = TASK_REPEAT_COUNTS[repeat];
  if (count > 1 && !values.due_at) throw badRequest("Set a due date to repeat this task.");
  const client = count > 1 ? await db.connect() : db;
  const items = [];
  try {
    if (count > 1) await client.query("BEGIN");
    for (let i = 0; i < count; i++) {
      const dueAt = values.due_at ? (i ? recurringDueAt(values.due_at, repeat, i) : values.due_at) : null;
      const result = await client.query(
        `INSERT INTO tasks (class_id, subject_id, title, description, due_at, priority, created_by, is_private)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [classId, values.subject_id || null, values.title, values.description || null, dueAt, values.priority || "normal", userId, isPrivate]
      );
      items.push(result.rows[0]);
    }
    if (count > 1) await client.query("COMMIT");
    return items;
  } catch (error) {
    if (count > 1) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (count > 1) client.release();
  }
}

async function recordContentEvent(db, req, action, item) {
  const resource = req.params.resource;
  await logActivity(db, {
    classId: req.params.classId,
    userId: req.user.id,
    action,
    entityType: resource,
    entityId: item.id,
    summary: `${action === "create" ? "added" : action === "update" ? "updated" : "deleted"} ${singular[resource]} “${itemName(item)}”`
  });
}

// ---- generic list / create / update / delete for subjects, schedules and tasks ----
router.get("/:classId/temporary-schedules", requireClassMember, async (req, res, next) => {
  try {
    const { rows } = await req.app.locals.db.query(
      `SELECT ts.*, COALESCE(json_agg(json_build_object('id',e.id,'title',e.title,'subject',e.subject,'entry_date',e.entry_date,'start_time',e.start_time,'end_time',e.end_time,'room',e.room) ORDER BY e.entry_date,e.start_time) FILTER (WHERE e.id IS NOT NULL),'[]') AS entries
       FROM temporary_schedules ts LEFT JOIN temporary_schedule_entries e ON e.schedule_id=ts.id
       WHERE ts.class_id=$1 AND ts.end_date >= CURRENT_DATE GROUP BY ts.id ORDER BY ts.start_date`, [req.params.classId]);
    res.json({ temporary_schedules: rows });
  } catch (error) { next(error); }
});

router.post("/:classId/temporary-schedules", requireClassAdmin, async (req, res, next) => {
  const db = req.app.locals.db;
  let client;
  try {
    client = await db.connect();
    const title = cleanText(req.body?.title, "Title", 120, { required: true });
    const startDate = String(req.body?.start_date || ""); const endDate = String(req.body?.end_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) throw badRequest("Enter a valid schedule date range.");
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!entries.length || entries.length > 200) throw badRequest("Add between 1 and 200 schedule entries.");
    await client.query("BEGIN");
    const made = await client.query("INSERT INTO temporary_schedules(class_id,title,start_date,end_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *", [req.params.classId,title,startDate,endDate,req.user.id]);
    for (const e of entries) {
      const entryTitle = cleanText(e.title, "Entry title", 160, { required: true });
      const date = String(e.entry_date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate || !TIME_RE.test(String(e.start_time || "")) || !TIME_RE.test(String(e.end_time || "")) || e.end_time <= e.start_time) throw badRequest("Each entry needs a valid date and time within the schedule range.");
      await client.query("INSERT INTO temporary_schedule_entries(schedule_id,title,subject,entry_date,start_time,end_time,room) VALUES($1,$2,$3,$4,$5,$6,$7)", [made.rows[0].id,entryTitle,cleanText(e.subject,"Subject",120) || null,date,e.start_time,e.end_time,cleanText(e.room,"Room",100) || null]);
    }
    await client.query("COMMIT"); res.status(201).json({ schedule: made.rows[0] });
  } catch (error) { if (client) await client.query("ROLLBACK").catch(() => {}); next(error); }
  finally { client?.release(); }
});

router.get("/:classId/:resource(subjects|schedules|tasks)", requireClassMember, async (req, res, next) => {
  try {
    const cfg = resourceFor(req, res); if (!cfg) return;
    let query = `SELECT * FROM ${cfg.table} WHERE class_id=$1 ORDER BY ${cfg.order}`;
    const params = [req.params.classId];
    if (cfg.table === "tasks") {
      // completion is per student; admins also see how many students have finished each task
      query = `SELECT t.*, (tc.user_id IS NOT NULL) AS completed,
          (SELECT COUNT(*)::int FROM task_completions c WHERE c.task_id=t.id) AS completed_count
        FROM tasks t
        LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=$2
        WHERE t.class_id=$1 AND (t.is_private = FALSE OR t.created_by=$2)
        ORDER BY t.due_at NULLS LAST, t.created_at DESC`;
      params.push(req.user.id);
    }
    const result = await req.app.locals.db.query(query, params);
    res.json({ [req.params.resource]: result.rows });
  } catch (error) { next(error); }
});

router.post("/:classId/:resource(subjects|schedules|tasks)", requireClassAdmin, async (req, res, next) => {
  try {
    const cfg = resourceFor(req, res); if (!cfg) return;
    const db = req.app.locals.db;
    const values = parseResource(cfg, req.body, { partial: false });
    if (cfg.table === "schedules" && normalizeTime(values.end_time) <= normalizeTime(values.start_time)) {
      throw badRequest("End time must be later than start time.");
    }
    await assertSubjectInClass(db, values.subject_id, req.params.classId);
    if (cfg.table === "tasks") {
      const repeat = String(req.body?.repeat || "none");
      const items = await createTaskInstances(db, { classId: req.params.classId, userId: req.user.id, values, isPrivate: false, repeat });
      const item = items[0];
      await recordContentEvent(db, req, "create", item);
      await notifyClass(db, { classId: req.params.classId, actorId: req.user.id, type: "task", title: `New task: ${item.title}`, body: item.description || null, page: "tasks", entityId: item.id });
      return res.status(201).json({ item, items, created_count: items.length });
    }
    values.class_id = req.params.classId;
    values.created_by = req.user.id;
    const cols = Object.keys(values);
    const result = await db.query(
      `INSERT INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      Object.values(values)
    );
    const item = result.rows[0];
    await recordContentEvent(db, req, "create", item);
    res.status(201).json({ item });
  } catch (error) { next(error); }
});

router.patch("/:classId/:resource(subjects|schedules|tasks)/:id", requireClassAdmin, async (req, res, next) => {
  try {
    const cfg = resourceFor(req, res); if (!cfg) return;
    const db = req.app.locals.db;
    const values = parseResource(cfg, req.body, { partial: true });
    if (!Object.keys(values).length) throw badRequest("No valid fields supplied.");
    for (const name of cfg.required) if (name in values && values[name] === null) throw badRequest(`${name.replace(/_/g, " ")} is required.`);
    await assertSubjectInClass(db, values.subject_id, req.params.classId);

    if (cfg.table === "schedules" && ("start_time" in values || "end_time" in values)) {
      const existing = await db.query("SELECT start_time, end_time FROM schedules WHERE id=$1 AND class_id=$2", [req.params.id, req.params.classId]);
      if (!existing.rows[0]) return res.status(404).json({ error: "Item not found." });
      const start = values.start_time || String(existing.rows[0].start_time);
      const end = values.end_time || String(existing.rows[0].end_time);
      if (normalizeTime(end) <= normalizeTime(start)) throw badRequest("End time must be later than start time.");
    }

    const cols = Object.keys(values);
    const sets = cols.map((c, i) => `${c}=$${i + 1}`);
    if (cfg.touchUpdatedAt) sets.push("updated_at=NOW()");
    const privateGuard = cfg.table === "tasks" ? " AND is_private=FALSE" : "";
    const result = await db.query(
      `UPDATE ${cfg.table} SET ${sets.join(",")} WHERE id=$${cols.length + 1} AND class_id=$${cols.length + 2}${privateGuard} RETURNING *`,
      [...Object.values(values), req.params.id, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Item not found." });
    await recordContentEvent(db, req, "update", result.rows[0]);
    res.json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

router.delete("/:classId/:resource(subjects|schedules|tasks)/:id", requireClassAdmin, async (req, res, next) => {
  try {
    const cfg = resourceFor(req, res); if (!cfg) return;
    const privateGuard = cfg.table === "tasks" ? " AND is_private=FALSE" : "";
    const result = await req.app.locals.db.query(
      `DELETE FROM ${cfg.table} WHERE id=$1 AND class_id=$2${privateGuard} RETURNING *`,
      [req.params.id, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Item not found." });
    await recordContentEvent(req.app.locals.db, req, "delete", result.rows[0]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/:classId/:resource(subjects|tasks)/bulk-delete", requireClassAdmin, async (req, res, next) => {
  try {
    const cfg = resourceFor(req, res); if (!cfg) return;
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter(isUuid))].slice(0, 200) : [];
    if (!ids.length) throw badRequest("Select at least one item to delete.");
    const privateGuard = cfg.table === "tasks" ? " AND is_private=FALSE" : "";
    const result = await req.app.locals.db.query(
      `DELETE FROM ${cfg.table} WHERE class_id=$1 AND id=ANY($2::uuid[])${privateGuard} RETURNING id`,
      [req.params.classId, ids]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (error) { next(error); }
});

// ---- private (personal) tasks: any member can keep tasks only they can see ----
router.post("/:classId/tasks/private", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const values = parseResource(resources.tasks, req.body, { partial: false });
    await assertSubjectInClass(db, values.subject_id, req.params.classId);
    const repeat = String(req.body?.repeat || "none");
    const items = await createTaskInstances(db, { classId: req.params.classId, userId: req.user.id, values, isPrivate: true, repeat });
    res.status(201).json({ item: items[0], items, created_count: items.length });
  } catch (error) { next(error); }
});

router.patch("/:classId/tasks/private/:id", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const existing = await db.query(
      "SELECT id, created_by FROM tasks WHERE id=$1 AND class_id=$2 AND is_private=TRUE",
      [req.params.id, req.params.classId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Task not found." });
    if (existing.rows[0].created_by !== req.user.id) return res.status(404).json({ error: "Task not found." });
    const values = parseResource(resources.tasks, req.body, { partial: true });
    if (!Object.keys(values).length) throw badRequest("No valid fields supplied.");
    if ("title" in values && values.title === null) throw badRequest("Title is required.");
    await assertSubjectInClass(db, values.subject_id, req.params.classId);
    const cols = Object.keys(values);
    const result = await db.query(
      `UPDATE tasks SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")}
       WHERE id=$${cols.length + 1} AND class_id=$${cols.length + 2} AND created_by=$${cols.length + 3} AND is_private=TRUE RETURNING *`,
      [...Object.values(values), req.params.id, req.params.classId, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Task not found." });
    res.json({ item: result.rows[0] });
  } catch (error) { next(error); }
});

router.delete("/:classId/tasks/private/:id", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      "DELETE FROM tasks WHERE id=$1 AND class_id=$2 AND created_by=$3 AND is_private=TRUE RETURNING id",
      [req.params.id, req.params.classId, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Task not found." });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---- AI schedule import: scan proposes rows, import saves the ones an admin reviewed ----
router.post("/:classId/schedules/scan", requireClassAdmin, scanUpload.single("image"), async (req, res, next) => {
  try {
    const text = cleanText(req.body?.text, "Schedule text", 8000);
    if (!text && !req.file) throw badRequest("Attach a schedule photo or paste the schedule text.");
    if (req.file && !req.file.mimetype.startsWith("image/")) throw badRequest("Please upload an image of the schedule.");
    const scan = await scanSchedule({ text, image: req.file ? { mimeType: req.file.mimetype, buffer: req.file.buffer } : null });
    const raw = Array.isArray(scan) ? scan : scan.entries;
    const entries = raw.map(normalizeScannedEntry).filter((entry) => entry.title);
    const isoDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
    };
    res.json({ entries, schedule: { title: cleanText(scan.schedule_title, "Schedule title", 120) || "", start_date: isoDate(scan.start_date), end_date: isoDate(scan.end_date) }, skipped: raw.length - entries.length });
  } catch (error) { next(error); }
});

router.post("/:classId/schedules/import", requireClassAdmin, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const classId = req.params.classId;
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries || !entries.length) throw badRequest("There are no schedule entries to import.");
    if (entries.length > 100) throw badRequest("Too many entries at once (100 maximum).");
    const createSubjects = req.body?.createSubjects !== false;

    const existing = await db.query("SELECT id, LOWER(name) AS name FROM subjects WHERE class_id=$1", [classId]);
    const subjectByName = new Map(existing.rows.map((row) => [row.name, row.id]));

    const inserted = [];
    for (const raw of entries) {
      const title = cleanText(raw?.title, "Title", 160, { required: true });
      const day = parseDay(raw?.day);
      if (day === null) throw badRequest(`“${title}” is missing a valid day.`);
      const start = parseClock(raw?.start_time);
      const end = parseClock(raw?.end_time);
      if (!start || !end) throw badRequest(`“${title}” needs valid start and end times.`);
      if (normalizeTime(end) <= normalizeTime(start)) throw badRequest(`“${title}”: the end time must be later than the start time.`);

      let subjectId = null;
      const subjectName = cleanText(raw?.subject, "Subject", 120);
      if (subjectName) {
        const key = subjectName.toLowerCase();
        if (subjectByName.has(key)) subjectId = subjectByName.get(key);
        else if (createSubjects) {
          const created = await db.query(
            "INSERT INTO subjects(class_id, name, created_by) VALUES($1,$2,$3) RETURNING id",
            [classId, subjectName, req.user.id]
          );
          subjectId = created.rows[0].id;
          subjectByName.set(key, subjectId);
        }
      }

      const row = await db.query(
        `INSERT INTO schedules(class_id, subject_id, title, day_of_week, start_time, end_time, room, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [classId, subjectId, title, day, start, end, cleanText(raw?.room, "Room", 100) || null, req.user.id]
      );
      inserted.push(row.rows[0]);
    }
    await logActivity(db, { classId, userId: req.user.id, action: "create", entityType: "schedule", summary: `imported ${inserted.length} schedule ${inserted.length === 1 ? "entry" : "entries"} from a scan` });
    res.status(201).json({ imported: inserted.length, schedules: inserted });
  } catch (error) { next(error); }
});

// ---- per-student task completion ----
router.put("/:classId/tasks/:taskId/completion", requireClassMember, async (req, res, next) => {
  try {
    const completed = req.body?.completed === true;
    const db = req.app.locals.db;
    const task = await db.query("SELECT id, is_private, created_by FROM tasks WHERE id=$1 AND class_id=$2", [req.params.taskId, req.params.classId]);
    if (!task.rows[0]) return res.status(404).json({ error: "Task not found." });
    if (task.rows[0].is_private && task.rows[0].created_by !== req.user.id) return res.status(404).json({ error: "Task not found." });
    if (completed) {
      await db.query("INSERT INTO task_completions(task_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.params.taskId, req.user.id]);
    } else {
      await db.query("DELETE FROM task_completions WHERE task_id=$1 AND user_id=$2", [req.params.taskId, req.user.id]);
    }
    res.json({ completed });
  } catch (error) { next(error); }
});

// ---- topics (Subject -> Topic -> Reviewer note) ----
router.get("/:classId/subjects/:subjectId/topics", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT t.*, (SELECT COUNT(*)::int FROM notes n WHERE n.topic_id=t.id) AS note_count
       FROM topics t JOIN subjects s ON s.id=t.subject_id
       WHERE t.subject_id=$1 AND s.class_id=$2 ORDER BY t.sort_order, t.created_at`,
      [req.params.subjectId, req.params.classId]
    );
    res.json({ topics: result.rows });
  } catch (error) { next(error); }
});

router.post("/:classId/subjects/:subjectId/topics", requireClassAdmin, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Topic title", 160, { required: true });
    const result = await req.app.locals.db.query(
      `INSERT INTO topics(subject_id,title,sort_order)
       SELECT s.id,$2,COALESCE((SELECT MAX(sort_order)+1 FROM topics WHERE subject_id=s.id),0)
       FROM subjects s WHERE s.id=$1 AND s.class_id=$3 RETURNING *`,
      [req.params.subjectId, title, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Subject not found." });
    const topic = result.rows[0];
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "topic", entityId: topic.id, summary: `added topic “${topic.title}”` });
    res.status(201).json({ topic });
  } catch (error) { next(error); }
});

router.patch("/:classId/topics/:topicId", requireClassAdmin, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Topic title", 160, { required: true });
    const result = await req.app.locals.db.query(
      `UPDATE topics t SET title=$1 FROM subjects s
       WHERE t.id=$2 AND s.id=t.subject_id AND s.class_id=$3 RETURNING t.*`,
      [title, req.params.topicId, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Topic not found." });
    const topic = result.rows[0];
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "topic", entityId: topic.id, summary: `renamed topic to “${topic.title}”` });
    res.json({ topic });
  } catch (error) { next(error); }
});

router.delete("/:classId/topics/:topicId", requireClassAdmin, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `DELETE FROM topics t USING subjects s
       WHERE t.id=$1 AND s.id=t.subject_id AND s.class_id=$2 RETURNING t.*`,
      [req.params.topicId, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Topic not found." });
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "delete", entityType: "topic", entityId: result.rows[0].id, summary: `deleted topic “${result.rows[0].title}”` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ---- reviewer notes ----
router.get("/:classId/topics/:topicId/notes", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT n.* FROM notes n JOIN topics t ON t.id=n.topic_id
       JOIN subjects s ON s.id=t.subject_id
       WHERE t.id=$1 AND s.class_id=$2 ORDER BY n.updated_at DESC`,
      [req.params.topicId, req.params.classId]
    );
    res.json({ notes: result.rows });
  } catch (error) { next(error); }
});

router.post("/:classId/topics/:topicId/notes", requireClassAdmin, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Note title", 180, { required: true });
    const content = cleanText(req.body?.content, "Content", 20000);
    const result = await req.app.locals.db.query(
      `INSERT INTO notes(subject_id,topic_id,title,content,created_by)
       SELECT t.subject_id,t.id,$2,$3,$4 FROM topics t JOIN subjects s ON s.id=t.subject_id
       WHERE t.id=$1 AND s.class_id=$5 RETURNING *`,
      [req.params.topicId, title, content, req.user.id, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Topic not found." });
    const noteRow = result.rows[0];
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "note", entityId: noteRow.id, summary: `added reviewer “${noteRow.title}”` });
    res.status(201).json({ note: noteRow });
  } catch (error) { next(error); }
});

// ---- reviewers (notes) attached directly to a subject ----
// A subject is now the single parent for reviewers, so the whole class can open a subject and see
// every hand-written and AI-generated reviewer in one list. Topics remain in the schema but unused.
router.get("/:classId/subjects/:subjectId/notes", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT n.* FROM notes n JOIN subjects s ON s.id=n.subject_id
       WHERE n.subject_id=$1 AND s.class_id=$2 ORDER BY n.updated_at DESC`,
      [req.params.subjectId, req.params.classId]
    );
    res.json({ notes: result.rows });
  } catch (error) { next(error); }
});

router.post("/:classId/subjects/:subjectId/notes", requireClassAdmin, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Note title", 180, { required: true });
    const content = cleanText(req.body?.content, "Content", 20000);
    const result = await req.app.locals.db.query(
      `INSERT INTO notes(subject_id,title,content,created_by)
       SELECT s.id,$2,$3,$4 FROM subjects s WHERE s.id=$1 AND s.class_id=$5 RETURNING *`,
      [req.params.subjectId, title, content, req.user.id, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Subject not found." });
    const noteRow = result.rows[0];
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "note", entityId: noteRow.id, summary: `added reviewer “${noteRow.title}”` });
    res.status(201).json({ note: noteRow });
  } catch (error) { next(error); }
});

// Everything filed under one subject: class reviewers (notes) and student files/notes (uploads),
// newest first, so tapping a subject shows one combined list.
router.get("/:classId/subjects/:subjectId/reviewers", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const subject = (await db.query("SELECT id, name FROM subjects WHERE id=$1 AND class_id=$2", [req.params.subjectId, req.params.classId])).rows[0];
    if (!subject) return res.status(404).json({ error: "Subject not found." });
    const result = await db.query(
      `SELECT 'note' AS kind, n.id, n.title, n.content, n.source, n.updated_at AS created_at, n.created_by AS user_id,
              u.full_name, u.username, NULL::text AS file_name, NULL::int AS file_size
       FROM notes n JOIN users u ON u.id=n.created_by
       WHERE n.subject_id=$1
       UNION ALL
       SELECT 'upload' AS kind, up.id, up.title, up.content, up.source, up.created_at, up.user_id,
              u.full_name, u.username, up.file_name, up.file_size
       FROM uploads up JOIN users u ON u.id=up.user_id
       WHERE up.subject_id=$1
       ORDER BY created_at DESC`,
      [req.params.subjectId]
    );
    res.json({ subject, reviewers: result.rows });
  } catch (error) { next(error); }
});

// Per-subject reviewer counts for the Notes dashboard cards.
router.get("/:classId/reviewer-summary", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT subject_id, COUNT(*)::int AS count FROM (
         SELECT subject_id FROM notes WHERE subject_id IN (SELECT id FROM subjects WHERE class_id=$1)
         UNION ALL
         SELECT subject_id FROM uploads WHERE subject_id IN (SELECT id FROM subjects WHERE class_id=$1)
       ) r WHERE subject_id IS NOT NULL GROUP BY subject_id`,
      [req.params.classId]
    );
    const summary = {};
    for (const row of result.rows) summary[row.subject_id] = row.count;
    res.json({ summary });
  } catch (error) { next(error); }
});

router.patch("/:classId/notes/:noteId", requireClassAdmin, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Note title", 180, { required: true });
    const content = cleanText(req.body?.content, "Content", 20000);
    const result = await req.app.locals.db.query(
      `UPDATE notes n SET title=$1, content=$2, updated_at=NOW() FROM subjects s
       WHERE n.id=$3 AND n.subject_id=s.id AND s.class_id=$4 RETURNING n.*`,
      [title, content, req.params.noteId, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Note not found." });
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "note", entityId: result.rows[0].id, summary: `edited reviewer “${result.rows[0].title}”` });
    res.json({ note: result.rows[0] });
  } catch (error) { next(error); }
});

router.delete("/:classId/notes/:noteId", requireClassAdmin, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `DELETE FROM notes n USING subjects s
       WHERE n.id=$1 AND n.subject_id=s.id AND s.class_id=$2 RETURNING n.*`,
      [req.params.noteId, req.params.classId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Note not found." });
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "delete", entityType: "note", entityId: result.rows[0].id, summary: `deleted reviewer “${result.rows[0].title}”` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get("/:classId/search", requireClassMember, async (req, res, next) => {
  try {
    const q = cleanText(String(req.query.q || ""), "Search", 200);
    const empty = { tasks: [], notes: [], subjects: [], schedules: [] };
    if (!q) return res.json({ results: empty });
    const like = `%${q}%`;
    const db = req.app.locals.db;
    const [tasks, subjects, schedules, notes] = await Promise.all([
      db.query(
        `SELECT t.*, (tc.user_id IS NOT NULL) AS completed
         FROM tasks t
         LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=$3
         WHERE t.class_id=$1 AND (t.title ILIKE $2 OR t.description ILIKE $2)
           AND (t.is_private = FALSE OR t.created_by=$3)
         ORDER BY t.due_at NULLS LAST, t.created_at DESC LIMIT 10`,
        [req.params.classId, like, req.user.id]
      ),
      db.query("SELECT s.* FROM subjects s WHERE s.class_id=$1 AND s.name ILIKE $2 ORDER BY s.name LIMIT 10", [req.params.classId, like]),
      db.query("SELECT s.* FROM schedules s WHERE s.class_id=$1 AND (s.title ILIKE $2 OR s.room ILIKE $2) ORDER BY s.day_of_week, s.start_time LIMIT 10", [req.params.classId, like]),
      db.query(
        `SELECT n.*, t.title AS topic_title, s.name AS subject_name
         FROM notes n JOIN subjects s ON s.id = n.subject_id
         LEFT JOIN topics t ON t.id = n.topic_id
         WHERE s.class_id = $1 AND (n.title ILIKE $2 OR n.content ILIKE $2)
         ORDER BY n.updated_at DESC LIMIT 10`,
        [req.params.classId, like]
      )
    ]);
    res.json({ results: { tasks: tasks.rows, notes: notes.rows, subjects: subjects.rows, schedules: schedules.rows } });
  } catch (error) { next(error); }
});

module.exports = router;
