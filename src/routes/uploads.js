const router = require("express").Router();
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { requireClassMember } = require("../middleware/classAccess");
const { badRequest, HttpError } = require("../middleware/errors");
const { isUuid, uuidParams, cleanText } = require("../middleware/validate");
const { logActivity } = require("../activity");

router.use(requireAuth);
uuidParams(router, "classId", "id");

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

const isManager = (role) => ["owner", "admin"].includes(role);

// Students can upload their own notes; files live in the database so one backup keeps everything.
router.post("/:classId", requireClassMember, upload.single("file"), async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const title = cleanText(req.body?.title, "Title", 180, { required: true });
    const content = cleanText(req.body?.content, "Content", 20000);
    const subjectId = req.body?.subject_id ? (isUuid(req.body.subject_id) ? req.body.subject_id : (() => { throw badRequest("Subject is not valid."); })()) : null;
    const topicId = req.body?.topic_id ? (isUuid(req.body.topic_id) ? req.body.topic_id : (() => { throw badRequest("Topic is not valid."); })()) : null;
    if (!content && !req.file) throw badRequest("Add some text or attach a file.");

    if (subjectId) {
      const s = await db.query("SELECT 1 FROM subjects WHERE id=$1 AND class_id=$2", [subjectId, req.params.classId]);
      if (!s.rowCount) throw badRequest("That subject does not belong to this class.");
    }
    if (topicId) {
      const t = await db.query(
        "SELECT 1 FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE t.id=$1 AND s.class_id=$2",
        [topicId, req.params.classId]
      );
      if (!t.rowCount) throw badRequest("That topic does not belong to this class.");
    }

    const result = await db.query(
      `INSERT INTO uploads (class_id, subject_id, topic_id, user_id, title, content, file_name, file_type, file_size, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, class_id, subject_id, topic_id, user_id, title, content, file_name, file_type, file_size, created_at`,
      [req.params.classId, subjectId, topicId, req.user.id, title, content,
       req.file ? req.file.originalname : null,
       req.file ? req.file.mimetype : null,
       req.file ? req.file.size : null,
       req.file ? req.file.buffer : null]
    );
    const item = result.rows[0];
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "upload", entityId: item.id, summary: `uploaded a note “${item.title}”` });
    res.status(201).json({ upload: item });
  } catch (error) { next(error); }
});

router.get("/:classId", requireClassMember, async (req, res, next) => {
  try {
    const params = [req.params.classId];
    let where = "u.class_id=$1";
    if (req.query.subject_id) {
      if (!isUuid(req.query.subject_id)) throw badRequest("Subject is not valid.");
      params.push(req.query.subject_id);
      where += ` AND u.subject_id=$${params.length}`;
    }
    if (req.query.topic_id) {
      if (!isUuid(req.query.topic_id)) throw badRequest("Topic is not valid.");
      params.push(req.query.topic_id);
      where += ` AND u.topic_id=$${params.length}`;
    }
    const result = await req.app.locals.db.query(
      `SELECT u.id, u.class_id, u.subject_id, u.topic_id, u.user_id, u.title, u.content, u.source,
              u.file_name, u.file_type, u.file_size, u.created_at,
              usr.full_name, usr.username, sub.name AS subject_name, t.title AS topic_title
       FROM uploads u
       JOIN users usr ON usr.id = u.user_id
       LEFT JOIN subjects sub ON sub.id = u.subject_id
       LEFT JOIN topics t ON t.id = u.topic_id
       WHERE ${where}
       ORDER BY u.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ uploads: result.rows });
  } catch (error) { next(error); }
});

router.get("/:classId/:id/file", requireClassMember, async (req, res, next) => {
  try {
    const file = (await req.app.locals.db.query(
      "SELECT file_name, file_type, file_data FROM uploads WHERE id=$1 AND class_id=$2",
      [req.params.id, req.params.classId]
    )).rows[0];
    if (!file || !file.file_data) return res.status(404).json({ error: "No file attached to that note." });
    res.setHeader("Content-Type", file.file_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name || "note")}`);
    res.send(file.file_data);
  } catch (error) { next(error); }
});

router.delete("/:classId/:id", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const row = (await db.query("SELECT id, user_id, title FROM uploads WHERE id=$1 AND class_id=$2", [req.params.id, req.params.classId])).rows[0];
    if (!row) return res.status(404).json({ error: "Upload not found." });
    if (row.user_id !== req.user.id && !isManager(req.membership.role)) throw new HttpError(403, "You can only delete your own uploads.");
    await db.query("DELETE FROM uploads WHERE id=$1", [row.id]);
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "delete", entityType: "upload", entityId: row.id, summary: `deleted note “${row.title}”` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
