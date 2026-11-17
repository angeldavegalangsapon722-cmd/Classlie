const router = require("express").Router();
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { getMembership, requireClassMember } = require("../middleware/classAccess");
const { HttpError, badRequest } = require("../middleware/errors");
const { uuidParams, cleanText, isUuid } = require("../middleware/validate");
const { logActivity } = require("../activity");

router.use(requireAuth);
uuidParams(router, "classId", "userId");

// No 0/O/1/I so codes are easy to read aloud.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
function newCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function classFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = cleanText(body.name, "Class name", 120, { required: true });
  if (!partial || body.section !== undefined) out.section = cleanText(body.section, "Section", 80);
  if (!partial || body.school !== undefined) out.school = cleanText(body.school, "School", 160);
  if (!partial || body.academicYear !== undefined) out.academic_year = cleanText(body.academicYear, "Academic year", 40);
  return out;
}

router.get("/", async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(`
      SELECT c.*, cm.role,
        (SELECT COUNT(*)::int FROM class_members x WHERE x.class_id=c.id) AS member_count
      FROM classes c JOIN class_members cm ON cm.class_id=c.id
      WHERE cm.user_id=$1 ORDER BY c.created_at DESC`, [req.user.id]);
    res.json({ classes: result.rows });
  } catch (error) { next(error); }
});

router.post("/", async (req, res, next) => {
  let client;
  try {
    const f = classFields(req.body || {});
    client = await req.app.locals.db.connect();
    await client.query("BEGIN");
    let created;
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      const inserted = await client.query(
        `INSERT INTO classes (name,section,school,academic_year,code,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING *`,
        [f.name, f.section, f.school, f.academic_year, newCode(), req.user.id]
      );
      created = inserted.rows[0];
    }
    if (!created) throw new HttpError(503, "Could not generate a class code. Please try again.");
    await client.query("INSERT INTO class_members (class_id,user_id,role) VALUES ($1,$2,'owner')", [created.id, req.user.id]);
    await client.query("COMMIT");
    await logActivity(req.app.locals.db, { classId: created.id, userId: req.user.id, action: "create", entityType: "class", entityId: created.id, summary: `created the class “${created.name}”` });
    res.status(201).json({ class: { ...created, role: "owner", member_count: 1 } });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post("/join", async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) throw badRequest("Enter a class code.");
    const db = req.app.locals.db;
    const found = await db.query("SELECT * FROM classes WHERE code=$1", [code]);
    if (!found.rows[0]) return res.status(404).json({ error: "No class found with that code." });
    const classRow = found.rows[0];
    const joined = await db.query(
      `INSERT INTO class_members (class_id,user_id,role) VALUES ($1,$2,'student')
       ON CONFLICT (class_id,user_id) DO NOTHING RETURNING role`,
      [classRow.id, req.user.id]
    );
    const membership = await getMembership(db, classRow.id, req.user.id);
    if (joined.rowCount > 0) await logActivity(db, { classId: classRow.id, userId: req.user.id, action: "join", entityType: "member", entityId: req.user.id, summary: `joined the class` });
    res.json({ class: { ...classRow, role: membership.role }, alreadyMember: joined.rowCount === 0 });
  } catch (error) { next(error); }
});

router.get("/:classId", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT c.*, $2::text AS role,
       (SELECT COUNT(*)::int FROM class_members cm WHERE cm.class_id=c.id) AS member_count
       FROM classes c WHERE c.id=$1`, [req.params.classId, req.membership.role]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Class not found." });
    res.json({ class: result.rows[0] });
  } catch (error) { next(error); }
});

router.patch("/:classId", requireClassMember, async (req, res, next) => {
  try {
    if (req.membership.role !== "owner") throw new HttpError(403, "Only the class owner can edit class details.");
    const f = classFields(req.body || {}, { partial: true });
    const cols = Object.keys(f);
    if (!cols.length) throw badRequest("Nothing to update.");
    const result = await req.app.locals.db.query(
      `UPDATE classes SET ${cols.map((c, i) => `${c}=$${i + 1}`).join(",")} WHERE id=$${cols.length + 1} RETURNING *`,
      [...Object.values(f), req.params.classId]
    );
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "class", entityId: req.params.classId, summary: "updated the class details" });
    res.json({ class: { ...result.rows[0], role: "owner" } });
  } catch (error) { next(error); }
});

router.get("/:classId/members", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT u.id,u.full_name,u.username,u.email,u.avatar_url,u.active_status,cm.role,cm.joined_at
       FROM class_members cm JOIN users u ON u.id=cm.user_id
       WHERE cm.class_id=$1 ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.full_name`,
      [req.params.classId]
    );
    // Email addresses are only for people who manage the class.
    const canSeeEmail = ["owner", "admin"].includes(req.membership.role);
    const viewerActive = (await req.app.locals.db.query("SELECT active_status FROM users WHERE id=$1", [req.user.id])).rows[0]?.active_status !== false;
    res.json({ members: result.rows.map(({ email, active_status, ...m }) => ({ ...m, active: viewerActive && active_status !== false, ...(canSeeEmail ? { email } : {}) })) });
  } catch (error) { next(error); }
});

router.get("/:classId/activity", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `SELECT a.id, a.action, a.entity_type, a.summary, a.created_at,
              u.id AS user_id, u.full_name, u.username
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.class_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [req.params.classId]
    );
    res.json({ activity: result.rows });
  } catch (error) { next(error); }
});

router.patch("/:classId/members/:userId/role", requireClassMember, async (req, res, next) => {
  try {
    if (req.membership.role !== "owner") throw new HttpError(403, "Only the class owner can change admin roles.");
    const { role } = req.body || {};
    if (!["admin", "student"].includes(role)) throw badRequest("Role must be admin or student.");
    const db = req.app.locals.db;
    const target = await getMembership(db, req.params.classId, req.params.userId);
    if (!target) return res.status(404).json({ error: "Member not found." });
    if (target.role === "owner") throw badRequest("The owner role cannot be changed here.");
    await db.query("UPDATE class_members SET role=$1 WHERE class_id=$2 AND user_id=$3", [role, req.params.classId, req.params.userId]);
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "update", entityType: "member", entityId: req.params.userId, summary: `changed a member's role to ${role}` });
    res.json({ ok: true, role });
  } catch (error) { next(error); }
});

router.patch("/:classId/owner", requireClassMember, async (req, res, next) => {
  let client;
  try {
    if (req.membership.role !== "owner") throw new HttpError(403, "Only the class owner can transfer ownership.");
    const { userId } = req.body || {};
    if (!isUuid(userId)) throw badRequest("Choose a member to transfer ownership to.");
    if (userId === req.user.id) throw badRequest("You are already the owner.");
    const db = req.app.locals.db;
    const target = await getMembership(db, req.params.classId, userId);
    if (!target) return res.status(404).json({ error: "Member not found." });
    client = await db.connect();
    await client.query("BEGIN");
    await client.query("UPDATE class_members SET role='admin' WHERE class_id=$1 AND user_id=$2", [req.params.classId, req.user.id]);
    await client.query("UPDATE class_members SET role='owner' WHERE class_id=$1 AND user_id=$2", [req.params.classId, userId]);
    await client.query("UPDATE classes SET created_by=$1 WHERE id=$2", [userId, req.params.classId]);
    await client.query("COMMIT");
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "transfer", entityType: "member", entityId: userId, summary: "transferred class ownership" });
    res.json({ ok: true });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    if (client) client.release();
  }
});

router.delete("/:classId/members/:userId", requireClassMember, async (req, res, next) => {
  try {
    const current = req.membership;
    if (!["owner", "admin"].includes(current.role)) throw new HttpError(403, "Only admins can remove members.");
    const db = req.app.locals.db;
    const target = await getMembership(db, req.params.classId, req.params.userId);
    if (!target) return res.status(404).json({ error: "Member not found." });
    if (target.role === "owner") throw badRequest("The owner cannot be removed.");
    if (current.role === "admin" && target.role === "admin") throw new HttpError(403, "Admins cannot remove another admin.");
    await db.query("DELETE FROM class_members WHERE class_id=$1 AND user_id=$2", [req.params.classId, req.params.userId]);
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "remove", entityType: "member", entityId: req.params.userId, summary: "removed a member from the class" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete("/:classId/leave", async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const membership = await getMembership(db, req.params.classId, req.user.id);
    if (!membership) return res.status(404).json({ error: "You are not a member of this class." });
    if (membership.role === "owner") throw badRequest("Owners can't leave their own class. Delete the class instead.");
    await db.query("DELETE FROM class_members WHERE class_id=$1 AND user_id=$2", [req.params.classId, req.user.id]);
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "leave", entityType: "member", entityId: req.user.id, summary: "left the class" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete("/:classId", requireClassMember, async (req, res, next) => {
  try {
    if (req.membership.role !== "owner") throw new HttpError(403, "Only the class owner can delete this class.");
    await req.app.locals.db.query("DELETE FROM classes WHERE id=$1", [req.params.classId]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
