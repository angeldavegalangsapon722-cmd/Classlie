const router = require("express").Router();
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { requireClassMember } = require("../middleware/classAccess");
const { badRequest } = require("../middleware/errors");
const { isUuid, uuidParams, cleanText } = require("../middleware/validate");
const { logActivity } = require("../activity");
const { extractDocument } = require("../extract");
const { generateReviewer, generateQuiz, generateStudyPlan, askClasslie } = require("../gemini");
const { upcomingSessions, describeSession, nowLine, fmtClock } = require("../classTime");

router.use(requireAuth);
uuidParams(router, "classId", "quizId", "subjectId", "cardId");

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — big enough for slide decks and PDFs
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

const MAX_NOTE_CHARS = 20000; // matches the notes/uploads columns

// Resolve a set of subject ids, keeping only the ones that really belong to this class.
async function subjectsInClass(db, classId, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const clean = ids.filter(isUuid).slice(0, 40);
  if (!clean.length) return [];
  const result = await db.query(
    "SELECT id, name FROM subjects WHERE id = ANY($1::uuid[]) AND class_id=$2 ORDER BY name",
    [clean, classId]
  );
  return result.rows;
}

async function notesForSubjects(db, classId, subjectIds) {
  if (!subjectIds.length) return [];
  const result = await db.query(
    `SELECT title, content FROM (
       SELECT n.title, n.content, n.updated_at FROM notes n WHERE n.subject_id = ANY($1::uuid[])
       UNION ALL
       SELECT u.title, u.content, u.created_at AS updated_at FROM uploads u WHERE u.subject_id = ANY($1::uuid[]) AND u.class_id = $2
     ) t ORDER BY updated_at DESC`,
    [subjectIds, classId]
  );
  return result.rows;
}

// Legacy topic resolution, kept so older clients (and the topic endpoints) still generate correctly.
async function topicsInClass(db, classId, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const clean = ids.filter(isUuid).slice(0, 40);
  if (!clean.length) return [];
  const result = await db.query(
    `SELECT t.id, t.title, s.name AS subject_name
     FROM topics t JOIN subjects s ON s.id=t.subject_id
     WHERE t.id = ANY($1::uuid[]) AND s.class_id=$2 ORDER BY t.sort_order, t.created_at`,
    [clean, classId]
  );
  return result.rows;
}

async function notesForTopics(db, topicIds) {
  if (!topicIds.length) return [];
  const result = await db.query(
    "SELECT title, content FROM notes WHERE topic_id = ANY($1::uuid[]) ORDER BY updated_at DESC",
    [topicIds]
  );
  return result.rows;
}

/* ---------------- AI reviewer ---------------- */

// Read an uploaded deck/document (or pasted text) and draft a reviewer. Nothing is saved yet —
// the client shows an editable preview and calls /reviewers/save once happy.
router.post("/:classId/reviewers/generate", requireClassMember, upload.single("file"), async (req, res, next) => {
  try {
    const text = cleanText(req.body?.text, "Text", 120000);
    const hint = cleanText(req.body?.title_hint, "Title", 160);
    let source = null;
    let extracted = {};
    if (req.file) {
      extracted = extractDocument({ buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname });
      source = { fileName: req.file.originalname, bytes: req.file.size, kind: extracted.text ? "text" : "document" };
    }
    if (!extracted.text && !extracted.inline && !text) throw badRequest("Add a file or paste some text first.");
    const reviewer = await generateReviewer({ text: [extracted.text, text].filter(Boolean).join("\n\n") || null, inline: extracted.inline, hint });
    if (source && extracted.text) source.chars = extracted.text.length;
    res.json({ reviewer, source });
  } catch (error) { next(error); }
});

// Save a (possibly edited) reviewer under the chosen subject. Admins file it as a class reviewer
// note; everyone else keeps it as their own shared note, exactly like a normal upload — but both
// land in the same subject so the class sees one combined list.
router.post("/:classId/reviewers/save", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const title = cleanText(req.body?.title, "Title", 180, { required: true });
    const content = cleanText(req.body?.content, "Content", MAX_NOTE_CHARS, { required: true });
    const subjectId = req.body?.subject_id && isUuid(req.body.subject_id) ? req.body.subject_id : null;
    const topicId = req.body?.topic_id
      ? (isUuid(req.body.topic_id) ? req.body.topic_id : (() => { throw badRequest("Topic is not valid."); })())
      : null;
    const isAdmin = ["owner", "admin"].includes(req.membership.role);

    if (!subjectId) throw badRequest("Pick a subject to save this reviewer under.");
    const subject = await db.query("SELECT 1 FROM subjects WHERE id=$1 AND class_id=$2", [subjectId, req.params.classId]);
    if (!subject.rowCount) throw badRequest("That subject does not belong to this class.");
    if (topicId) {
      const topic = await db.query(
        `SELECT 1 FROM topics t JOIN subjects s ON s.id=t.subject_id
         WHERE t.id=$1 AND t.subject_id=$2 AND s.class_id=$3`,
        [topicId, subjectId, req.params.classId]
      );
      if (!topic.rowCount) throw badRequest("That topic does not belong to this subject and class.");
    }

    if (isAdmin) {
      const rows = await db.query(
        `INSERT INTO notes(subject_id,topic_id,title,content,created_by,source)
         VALUES($1,$2,$3,$4,$5,'ai') RETURNING *`,
        [subjectId, topicId, title, content, req.user.id]
      );
      const note = rows.rows[0];
      await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "note", entityId: note.id, summary: `generated reviewer “${note.title}”` });
      return res.status(201).json({ kind: "note", note });
    }

    const uploads = await db.query(
      `INSERT INTO uploads(class_id,subject_id,topic_id,user_id,title,content,source)
       VALUES ($1,$2,$3,$4,$5,$6,'ai') RETURNING id, class_id, subject_id, topic_id, user_id, title, content, source, created_at`,
      [req.params.classId, subjectId, topicId, req.user.id, title, content]
    );
    const item = uploads.rows[0];
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "upload", entityId: item.id, summary: `generated a note “${item.title}”` });
    res.status(201).json({ kind: "upload", upload: item });
  } catch (error) { next(error); }
});

/* ---------------- quizzes ---------------- */

const QUIZ_SELECT = `SELECT q.id, q.class_id, q.subject_id, q.title, q.difficulty, q.questions, q.created_by, q.created_at,
    s.name AS subject_name, u.full_name, u.username,
    (SELECT COUNT(*)::int FROM quiz_attempts a WHERE a.quiz_id=q.id) AS attempt_count
  FROM quizzes q
  LEFT JOIN subjects s ON s.id=q.subject_id
  JOIN users u ON u.id=q.created_by`;

router.get("/:classId/quizzes", requireClassMember, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      `${QUIZ_SELECT} WHERE q.class_id=$1 ORDER BY q.created_at DESC LIMIT 100`,
      [req.params.classId]
    );
    const stats = await req.app.locals.db.query(
      `SELECT quiz_id, COUNT(*)::int AS attempts, MAX(score)::int AS best_score,
              (array_agg(total ORDER BY created_at DESC))[1] AS last_total,
              (array_agg(score ORDER BY created_at DESC))[1] AS last_score,
              (array_agg(created_at ORDER BY created_at DESC))[1] AS last_at
       FROM quiz_attempts WHERE user_id=$1 GROUP BY quiz_id`,
      [req.user.id]
    );
    const mine = new Map(stats.rows.map((r) => [r.quiz_id, r]));
    const dueReviews = await req.app.locals.db.query(
      `SELECT quiz_id, array_agg(question_index ORDER BY due_at ASC) AS due_question_indices
       FROM quiz_question_reviews WHERE user_id=$1 AND due_at <= NOW() GROUP BY quiz_id`,
      [req.user.id]
    );
    const dueByQuiz = new Map(dueReviews.rows.map((row) => [row.quiz_id, row.due_question_indices || []]));
    res.json({ quizzes: result.rows.map((q) => {
      const s = mine.get(q.id);
      const dueQuestionIndices = dueByQuiz.get(q.id) || [];
      return {
        ...q,
        question_count: (q.questions || []).length,
        due_question_indices: dueQuestionIndices,
        due_review_count: dueQuestionIndices.length,
        my_last: s ? { score: s.last_score, total: s.last_total, created_at: s.last_at } : null,
        my_attempts: s ? s.attempts : 0,
        my_best: s ? s.best_score : null
      };
    }) });
  } catch (error) { next(error); }
});

router.get("/:classId/quizzes/:quizId", requireClassMember, async (req, res, next) => {
  try {
    const quiz = (await req.app.locals.db.query(`${QUIZ_SELECT} WHERE q.class_id=$1 AND q.id=$2`, [req.params.classId, req.params.quizId])).rows[0];
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    const attempts = (await req.app.locals.db.query(
      "SELECT id, score, total, answers, created_at FROM quiz_attempts WHERE quiz_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20",
      [quiz.id, req.user.id]
    )).rows;
    const dueReviews = await req.app.locals.db.query(
      "SELECT question_index FROM quiz_question_reviews WHERE quiz_id=$1 AND user_id=$2 AND due_at <= NOW() ORDER BY due_at ASC",
      [quiz.id, req.user.id]
    );
    quiz.due_question_indices = dueReviews.rows.map((row) => Number(row.question_index));
    res.json({ quiz, attempts });
  } catch (error) { next(error); }
});

// Build a quiz from the reviewers under the chosen subjects (or legacy topics). Not saved yet.
router.post("/:classId/quizzes/generate", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const subjects = await subjectsInClass(db, req.params.classId, req.body?.subject_ids);
    let notes = Array.isArray(req.body?.reviewer_ids) || Array.isArray(req.body?.topic_ids)
      ? [] : await notesForSubjects(db, req.params.classId, subjects.map((s) => s.id));
    const topicRows = await topicsInClass(db, req.params.classId, req.body?.topic_ids);
    if (Array.isArray(req.body?.topic_ids) && req.body.topic_ids.length) {
      if (!topicRows.length) throw badRequest("Select at least one topic.");
      notes = await notesForTopics(db, topicRows.map((t) => t.id));
    }
    if (Array.isArray(req.body?.reviewer_ids) && req.body.reviewer_ids.length) {
      const reviewerIds = [...new Set(req.body.reviewer_ids.filter(isUuid))].slice(0, 100);
      const selected = await db.query(
        `SELECT title,content FROM notes WHERE id=ANY($1::uuid[]) AND subject_id=ANY($2::uuid[])
         UNION ALL SELECT title,content FROM uploads WHERE id=ANY($1::uuid[]) AND class_id=$3 AND subject_id=ANY($2::uuid[])`,
        [reviewerIds, subjects.map((s) => s.id), req.params.classId]
      );
      notes = [...notes, ...selected.rows];
      if (notes.length !== reviewerIds.length) throw badRequest("One or more selected reviewers no longer belong to these subjects.");
    }
    let label = subjects.length === 1 ? subjects[0].name : subjects[0]?.name;
    if (!subjects.length) {
      const topics = await topicsInClass(db, req.params.classId, req.body?.topic_ids);
      if (!topics.length) throw badRequest("Select at least one subject to quiz.");
      notes = await notesForTopics(db, topics.map((t) => t.id));
      label = topics[0].title;
    }
    if (!notes.length) throw badRequest("Those subjects don't have any reviewers to quiz yet.");
    const count = Math.min(Math.max(Number(req.body?.count) || 5, 3), 20);
    const difficulty = ["easy", "medium", "hard"].includes(req.body?.difficulty) ? req.body.difficulty : "medium";
    const quiz = await generateQuiz({ notes, count, difficulty });
    const autoTitle = subjects.length === 1 ? `${label} quiz` : `${label} quiz`;
    res.json({ quiz: { title: quiz.title || autoTitle, difficulty, questions: quiz.questions } });
  } catch (error) { next(error); }
});

// Persist a generated quiz so it can be reopened, retaken and scored.
router.post("/:classId/quizzes", requireClassMember, async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, "Quiz title", 200, { required: true });
    const difficulty = ["easy", "medium", "hard"].includes(req.body?.difficulty) ? req.body.difficulty : "medium";
    const subjectId = req.body?.subject_id && isUuid(req.body.subject_id) ? req.body.subject_id : null;
    const questions = req.body?.questions;
    if (!Array.isArray(questions) || !questions.length) throw badRequest("There are no questions to save.");
    const saved = questions.slice(0, 30).map((q, i) => {
      const options = Array.isArray(q?.options) ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6) : [];
      const answer = Number(q?.answer);
      if (!q?.question || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
        throw badRequest(`Question ${i + 1} is incomplete.`);
      }
      return { question: String(q.question).trim().slice(0, 500), options, answer, explanation: String(q.explanation || "").trim().slice(0, 400) };
    });
    const result = await req.app.locals.db.query(
      `INSERT INTO quizzes(class_id, subject_id, title, difficulty, questions, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id, class_id, subject_id, title, difficulty, questions, created_by, created_at`,
      [req.params.classId, subjectId, title, difficulty, JSON.stringify(saved), req.user.id]
    );
    const quiz = result.rows[0];
    await logActivity(req.app.locals.db, { classId: req.params.classId, userId: req.user.id, action: "create", entityType: "quiz", entityId: quiz.id, summary: `created quiz “${quiz.title}”` });
    res.status(201).json({ quiz });
  } catch (error) { next(error); }
});

router.delete("/:classId/quizzes/:quizId", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const quiz = (await db.query("SELECT id, created_by, title FROM quizzes WHERE id=$1 AND class_id=$2", [req.params.quizId, req.params.classId])).rows[0];
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    if (quiz.created_by !== req.user.id && !["owner", "admin"].includes(req.membership.role)) return res.status(403).json({ error: "You can only delete your own quizzes." });
    await db.query("DELETE FROM quizzes WHERE id=$1", [quiz.id]);
    await logActivity(db, { classId: req.params.classId, userId: req.user.id, action: "delete", entityType: "quiz", entityId: quiz.id, summary: `deleted quiz “${quiz.title}”` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Score server-side against the stored answer key, then keep the attempt for progress tracking.
router.post("/:classId/quizzes/:quizId/attempts", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const quiz = (await db.query("SELECT id, title, questions FROM quizzes WHERE id=$1 AND class_id=$2", [req.params.quizId, req.params.classId])).rows[0];
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    const questions = quiz.questions || [];
    const given = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const answers = questions.map((_q, i) => (Number.isInteger(given[i]) ? given[i] : null));
    const review = questions.map((q, i) => ({ index: i, chosen: answers[i], correct: q.answer, is_correct: answers[i] === q.answer, explanation: q.explanation || "" }));
    const score = review.filter((r) => r.is_correct).length;
    const total = questions.length;
    const incorrectIndices = review.filter((item) => !item.is_correct).map((item) => item.index);
    const client = await db.connect();
    let attempt;
    try {
      await client.query("BEGIN");
      attempt = (await client.query(
        `INSERT INTO quiz_attempts(quiz_id,user_id,score,total,answers,incorrect_indices)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         RETURNING id, score, total, answers, incorrect_indices, created_at`,
        [quiz.id, req.user.id, score, total, JSON.stringify(answers), JSON.stringify(incorrectIndices)]
      )).rows[0];
      for (const item of review) {
        if (!item.is_correct) {
          await client.query(
            `INSERT INTO quiz_question_reviews(quiz_id,user_id,question_index,due_at,interval_days,reps,lapses,last_reviewed_at)
             VALUES ($1,$2,$3,NOW() + INTERVAL '3 days',3,0,1,NOW())
             ON CONFLICT (quiz_id,user_id,question_index) DO UPDATE
               SET due_at=NOW() + INTERVAL '3 days', interval_days=3, reps=0,
                   lapses=quiz_question_reviews.lapses+1, last_reviewed_at=NOW()`,
            [quiz.id, req.user.id, item.index]
          );
        } else {
          await client.query(
            `UPDATE quiz_question_reviews
             SET interval_days=CASE WHEN reps=0 THEN 7 ELSE LEAST(interval_days*2,365) END,
                 reps=reps+1,
                 due_at=NOW() + (CASE WHEN reps=0 THEN 7 ELSE LEAST(interval_days*2,365) END) * INTERVAL '1 day',
                 last_reviewed_at=NOW()
             WHERE quiz_id=$1 AND user_id=$2 AND question_index=$3`,
            [quiz.id, req.user.id, item.index]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
    res.status(201).json({ attempt, review });
  } catch (error) { next(error); }
});

router.get("/:classId/quizzes/:quizId/attempts", requireClassMember, async (req, res, next) => {
  try {
    const attempts = (await req.app.locals.db.query(
      "SELECT id, score, total, answers, created_at FROM quiz_attempts WHERE quiz_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50",
      [req.params.quizId, req.user.id]
    )).rows;
    res.json({ attempts });
  } catch (error) { next(error); }
});

/* ---------------- study plan (personal, saved) ---------------- */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Build the text context the planner reasons over: class times, upcoming deadlines and subjects.
async function studyPlanContext(db, classId, userId) {
  const schedules = (await db.query(
    `SELECT s.title, s.day_of_week, s.start_time, s.end_time, s.room, sub.name AS subject_name
     FROM schedules s LEFT JOIN subjects sub ON sub.id=s.subject_id
     WHERE s.class_id=$1 ORDER BY s.day_of_week, s.start_time`,
    [classId]
  )).rows;
  const tasks = (await db.query(
    `SELECT t.title, t.due_at, t.priority, sub.name AS subject_name
     FROM tasks t LEFT JOIN subjects sub ON sub.id=t.subject_id
     LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=$2
     WHERE t.class_id=$1 AND tc.task_id IS NULL AND t.due_at IS NOT NULL
       AND t.due_at >= NOW() - INTERVAL '1 day'
     ORDER BY t.due_at ASC LIMIT 40`,
    [classId, userId]
  )).rows;
  const subjects = (await db.query("SELECT name FROM subjects WHERE class_id=$1 ORDER BY name", [classId])).rows.map((r) => r.name);
  const scheduleText = schedules.map((s) => `${DAY_NAMES[Number(s.day_of_week)] || "?"} ${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)} ${s.title}${s.subject_name ? ` (${s.subject_name})` : ""}`).join("\n");
  const taskText = tasks.map((t) => `${new Date(t.due_at).toISOString().slice(0, 10)} — ${t.title}${t.subject_name ? ` [${t.subject_name}]` : ""}${t.priority && t.priority !== "normal" ? ` (${t.priority})` : ""}`).join("\n");
  return { scheduleText, taskText, subjectsText: subjects.join(", ") };
}

router.get("/:classId/study-plan", requireClassMember, async (req, res, next) => {
  try {
    const row = (await req.app.locals.db.query(
      "SELECT title, plan, generated_at FROM study_plans WHERE user_id=$1 AND class_id=$2",
      [req.user.id, req.params.classId]
    )).rows[0];
    res.json({ plan: row ? { title: row.title, ...row.plan, generated_at: row.generated_at } : null });
  } catch (error) { next(error); }
});

router.post("/:classId/study-plan", requireClassMember, async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { scheduleText, taskText, subjectsText } = await studyPlanContext(db, req.params.classId, req.user.id);
    const plan = await generateStudyPlan({ schedule: scheduleText, tasks: taskText, subjects: subjectsText });
    const saved = (await db.query(
      `INSERT INTO study_plans(user_id, class_id, title, plan, generated_at)
       VALUES ($1,$2,$3,$4::jsonb,NOW())
       ON CONFLICT (user_id, class_id) DO UPDATE SET title=EXCLUDED.title, plan=EXCLUDED.plan, generated_at=NOW()
       RETURNING title, plan, generated_at`,
      [req.user.id, req.params.classId, plan.title, JSON.stringify({ summary: plan.summary, sessions: plan.sessions })]
    )).rows[0];
    res.json({ plan: { title: saved.title, ...saved.plan, generated_at: saved.generated_at } });
  } catch (error) { next(error); }
});

router.delete("/:classId/study-plan", requireClassMember, async (req, res, next) => {
  try {
    await req.app.locals.db.query("DELETE FROM study_plans WHERE user_id=$1 AND class_id=$2", [req.user.id, req.params.classId]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ---------------- ClasslieAI assistant (read-only) ---------------- */

// A compact, factual snapshot of the class the assistant is allowed to reason over.
// Rebuilt on every request so AI answers use the latest class data.
async function classSnapshotData(db, classId, userId, role = "student") {
  const [tasks, schedules, subjects, reviewers, topics, attendance, temporarySchedules, events] = await Promise.all([
    db.query(
      `SELECT t.title, t.description, t.due_at, t.priority, sub.name AS subject_name,
              (tc.task_id IS NOT NULL) AS done
       FROM tasks t
       LEFT JOIN subjects sub ON sub.id=t.subject_id
       LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=$2
       WHERE t.class_id=$1 AND (t.is_private = FALSE OR t.created_by=$2)
       ORDER BY (tc.task_id IS NOT NULL), t.due_at NULLS LAST`,
      [classId, userId]
    ).then((r) => r.rows),
    db.query(
      `SELECT s.title, s.day_of_week, s.start_time, s.end_time, s.room, sub.name AS subject_name
       FROM schedules s LEFT JOIN subjects sub ON sub.id=s.subject_id WHERE s.class_id=$1
       ORDER BY s.day_of_week, s.start_time`,
      [classId]
    ).then((r) => r.rows),
    db.query(
      `SELECT s.name, COUNT(n.id)::int AS reviewers
       FROM subjects s LEFT JOIN notes n ON n.subject_id=s.id
       WHERE s.class_id=$1 GROUP BY s.id, s.name ORDER BY s.name`,
      [classId]
    ).then((r) => r.rows),
    db.query(`SELECT s.name AS subject_name, n.title, n.content FROM notes n JOIN subjects s ON s.id=n.subject_id WHERE s.class_id=$1 UNION ALL SELECT s.name,u.title,u.content FROM uploads u JOIN subjects s ON s.id=u.subject_id WHERE u.class_id=$1 ORDER BY subject_name,title`, [classId]).then((r) => r.rows),
    db.query(`SELECT s.name AS subject_name,t.title FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE s.class_id=$1 ORDER BY s.name,t.sort_order`, [classId]).then((r) => r.rows),
    db.query(`SELECT ar.status, ar.occurred_on, ats.name, sub.name AS subject_name FROM attendance_records ar JOIN attendance_sessions ats ON ats.id=ar.session_id LEFT JOIN subjects sub ON sub.id=ats.subject_id WHERE ar.user_id=$2 AND ats.class_id=$1 ORDER BY ar.occurred_on DESC`, [classId,userId]).then((r) => r.rows),
    db.query(`SELECT ts.title,ts.start_date,ts.end_date,e.title AS entry_title,e.subject,e.entry_date,e.start_time,e.end_time,e.room FROM temporary_schedules ts LEFT JOIN temporary_schedule_entries e ON e.schedule_id=ts.id WHERE ts.class_id=$1 AND ts.end_date>=CURRENT_DATE ORDER BY ts.start_date,e.entry_date,e.start_time`, [classId]).then((r) => r.rows),
    db.query(`SELECT name,event_date,start_time,end_time,sub.name AS subject_name FROM attendance_sessions ats LEFT JOIN subjects sub ON sub.id=ats.subject_id WHERE ats.class_id=$1 AND ats.kind='date' AND ats.event_date>=CURRENT_DATE ORDER BY ats.event_date,ats.start_time`, [classId]).then((r) => r.rows)
  ]);
  let classAttendance = [];
  if (["owner", "admin"].includes(role)) classAttendance = (await db.query(`SELECT ar.status,COUNT(*)::int AS count FROM attendance_records ar JOIN attendance_sessions ats ON ats.id=ar.session_id WHERE ats.class_id=$1 GROUP BY ar.status`, [classId])).rows;
  const value = { tasks, schedules, subjects, reviewers, topics, attendance, classAttendance, temporarySchedules, events };
  return value;
}

// Time-sensitive parts (now / in class / next up) are rebuilt per request so a cached snapshot
// never tells the student the wrong "next" class.
function snapshotText({ tasks, schedules, subjects, reviewers = [], topics = [], attendance = [], classAttendance = [], temporarySchedules = [], events = [] }, timeZone) {
  const { now, ongoing, upcoming } = upcomingSessions(schedules, timeZone);
  const lines = [`Now: ${nowLine(now)}`];
  if (ongoing) {
    const subject = ongoing.subject_name ? ` (${ongoing.subject_name})` : "";
    const room = ongoing.room ? ` in ${ongoing.room}` : "";
    lines.push(`Currently in class: ${ongoing.title}${subject}${room}, ${fmtClock(ongoing.start)}-${fmtClock(ongoing.end)} (ends ${fmtClock(ongoing.end)})`);
  }
  if (upcoming.length) lines.push(`Upcoming classes (next 7 days):\n${upcoming.map((s) => `- ${describeSession(s)}`).join("\n")}`);
  if (subjects.length) lines.push(`Subjects: ${subjects.map((s) => `${s.name} (${s.reviewers} reviewer${s.reviewers === 1 ? "" : "s"})`).join(", ")}`);
  if (schedules.length) lines.push(`Schedule:\n${schedules.map((s) => `- ${DAY_NAMES[Number(s.day_of_week)]} ${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)} ${s.title}${s.subject_name ? ` (${s.subject_name})` : ""}${s.room ? ` in ${s.room}` : ""}`).join("\n")}`);
  if (temporarySchedules.length) lines.push(`Active/upcoming temporary schedules:\n${temporarySchedules.map((s) => `- ${s.title} (${String(s.start_date).slice(0,10)} to ${String(s.end_date).slice(0,10)}): ${s.entry_title ? `${String(s.entry_date).slice(0,10)} ${String(s.start_time).slice(0,5)}-${String(s.end_time).slice(0,5)} ${s.entry_title}${s.subject ? ` (${s.subject})` : ""}${s.room ? ` in ${s.room}` : ""}` : "no entries"}`).join("\n")}`);
  if (events.length) lines.push(`Upcoming dated class events:\n${events.map((e) => `- ${String(e.event_date).slice(0,10)} ${e.name}${e.subject_name ? ` (${e.subject_name})` : ""}${e.start_time ? ` ${String(e.start_time).slice(0,5)}-${String(e.end_time).slice(0,5)}` : ""}`).join("\n")}`);
  if (tasks.length) lines.push(`Tasks:\n${tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.title}${t.due_at ? ` — due ${new Date(t.due_at).toISOString().slice(0, 10)}` : ""}${t.subject_name ? ` (${t.subject_name})` : ""}${t.priority && t.priority !== "normal" ? ` [${t.priority}]` : ""}${t.description ? ` — ${t.description}` : ""}`).join("\n")}`);
  const counts = Object.fromEntries(["present","absent","late","excused"].map((status) => [status, attendance.filter((a) => a.status === status).length]));
  lines.push(`Your attendance: present ${counts.present}, absent ${counts.absent}, late ${counts.late}, excused ${counts.excused}.`);
  if (attendance.length) lines.push(`Your attendance records:\n${attendance.map((a) => `- ${String(a.occurred_on).slice(0,10)} ${a.status}: ${a.name}${a.subject_name ? ` (${a.subject_name})` : ""}`).join("\n")}`);
  if (classAttendance.length) lines.push(`Overall class attendance records: ${classAttendance.map((a) => `${a.status} ${a.count}`).join(", ")}`);
  if (reviewers.length) lines.push(`Reviewer contents:\n${reviewers.map((r) => `- ${r.subject_name} / ${r.title}: ${r.content}`).join("\n")}`);
  if (topics.length) lines.push(`Topics:\n${topics.map((t) => `- ${t.subject_name}: ${t.title}`).join("\n")}`);
  return lines.join("\n\n");
}

async function classSnapshot(db, classId, userId, timeZone = "UTC", role = "student") {
  return snapshotText(await classSnapshotData(db, classId, userId, role), timeZone);
}

router.post("/:classId/assistant", requireClassMember, async (req, res, next) => {
  try {
    const question = cleanText(req.body?.question, "Question", 2000, { required: true });
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const requestedZone = typeof req.body?.timezone === "string" ? req.body.timezone.trim() : "";
    const timeZone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(requestedZone) ? requestedZone : "UTC";
    const context = await classSnapshot(req.app.locals.db, req.params.classId, req.user.id, timeZone, req.membership.role);
    const answer = await askClasslie({ question, history, context });
    res.json({ answer });
  } catch (error) { next(error); }
});

module.exports = router;
