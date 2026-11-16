// Tests for the AI-assisted notes features: document extraction, reviewer saving,
// quiz generation/storage/scoring and flashcards validation.
// Run with: TEST_DATABASE_URL=postgresql://... JWT_SECRET=... npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");

delete process.env.GEMINI_API_KEY; // force the "not configured" path so tests never hit the network
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_test_secret_test_secret_123456";
const { createApp } = require("../src/app");
const { extractDocument } = require("../src/extract");

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error("Set TEST_DATABASE_URL to a throwaway database to run the tests."); process.exit(1); }

let pool, server, base;
const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const postForm = async (p, { token, fields = {}, file }) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("file", new Blob([file.buffer], { type: file.type }), file.name);
  const res = await fetch(base + p, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
async function signup(name) {
  const r = await call("POST", "/api/auth/register", { body: { fullName: `${name} Tester`, username: name, email: `${name}@example.com`, password: "password123" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

// Build a minimal in-memory .pptx (a zip with slide XML) to prove the extractor works with no files.
function makePptx(slides) {
  const crc32 = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const files = slides.map((text, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: `<p:sld><a:t>${text}</a:t></p:sld>` }));
  const locals = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.data, "utf8");
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    central.push(cd, name);
    off += lh.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

test("extract: reads .pptx slide text, plain text, and rejects unsupported files", () => {
  const pptx = extractDocument({ buffer: makePptx(["Cell theory", "Mitosis phases"]), mimetype: "", filename: "bio.pptx" });
  assert.match(pptx.text, /Slide 1: Cell theory/);
  assert.match(pptx.text, /Slide 2: Mitosis phases/);

  const txt = extractDocument({ buffer: Buffer.from("hello reviewer"), mimetype: "text/plain", filename: "a.txt" });
  assert.equal(txt.text, "hello reviewer");

  const pdf = extractDocument({ buffer: Buffer.from("%PDF-1.4"), mimetype: "application/pdf", filename: "a.pdf" });
  assert.equal(pdf.inline.mimeType, "application/pdf");

  assert.throws(() => extractDocument({ buffer: Buffer.from("x"), mimetype: "", filename: "a.zip" }), /Unsupported file/);
});

let owner, student, outsider, cls, subject, topic;
before(async () => {
  pool = new Pool({ connectionString: url });
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));
  await pool.query("TRUNCATE users CASCADE");
  server = await listen(createApp(pool, { rateLimiting: false }));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = await signup("aio"); student = await signup("ais"); outsider = await signup("aix");
  cls = (await call("POST", "/api/classes", { token: owner.token, body: { name: "AI Class" } })).body.class;
  await call("POST", "/api/classes/join", { token: student.token, body: { code: cls.code } });

  const p = `/api/class-data/${cls.id}`;
  subject = (await call("POST", `${p}/subjects`, { token: owner.token, body: { name: "GEC 6" } })).body.item;
  topic = (await call("POST", `${p}/subjects/${subject.id}/topics`, { token: owner.token, body: { title: "Module 6" } })).body.topic;
  await call("POST", `${p}/topics/${topic.id}/notes`, { token: owner.token, body: { title: "Photosynthesis", content: "**Light reactions** and the Calvin cycle." } });
});
after(async () => { server.close(); await pool.end(); });

test("ai: endpoints reject non-members and validate input", async () => {
  assert.equal((await call("POST", `/api/ai/${cls.id}/quizzes/generate`, { token: outsider.token, body: { topic_ids: [topic.id] } })).status, 403);
  assert.equal((await call("POST", `/api/ai/${cls.id}/quizzes/generate`, { token: owner.token, body: { topic_ids: [] } })).status, 400);

  const badQuiz = await call("POST", `/api/ai/${cls.id}/quizzes`, { token: owner.token, body: { title: "X", questions: [{ question: "q", options: ["a"], answer: 0 }] } });
  assert.equal(badQuiz.status, 400);
  assert.match(badQuiz.body.error, /Question 1/);

  // No GEMINI_API_KEY in the test env: generation explains it is not configured.
  const gen = await postForm(`/api/ai/${cls.id}/reviewers/generate`, { token: owner.token, file: { buffer: makePptx(["Some content"]), type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", name: "deck.pptx" } });
  assert.equal(gen.status, 503);
  assert.match(gen.body.error, /configured/);
});

test("study plan + assistant: personal plan storage and read-only Q&A", async () => {
  // A fresh member starts with no saved plan.
  const empty = await call("GET", `/api/ai/${cls.id}/study-plan`, { token: student.token });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.plan, null);

  // No GEMINI_API_KEY in tests, so generation explains it is not configured.
  const gen = await call("POST", `/api/ai/${cls.id}/study-plan`, { token: student.token });
  assert.equal(gen.status, 503);
  assert.match(gen.body.error, /configured/);

  const ask = await call("POST", `/api/ai/${cls.id}/assistant`, { token: student.token, body: { question: "What's due?" } });
  assert.equal(ask.status, 503);
  assert.match(ask.body.error, /configured/);

  // Validation and access control.
  assert.equal((await call("POST", `/api/ai/${cls.id}/assistant`, { token: student.token, body: {} })).status, 400);
  assert.equal((await call("POST", `/api/ai/${cls.id}/assistant`, { token: outsider.token, body: { question: "hi" } })).status, 403);
  assert.equal((await call("GET", `/api/ai/${cls.id}/study-plan`, { token: outsider.token })).status, 403);

  // Clearing a plan that does not exist is a harmless no-op.
  assert.equal((await call("DELETE", `/api/ai/${cls.id}/study-plan`, { token: student.token })).status, 200);
});

test("reviewers: admins save into the topic, students save as their own note", async () => {
  const adminSave = await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: owner.token, body: { title: "AI Photosynthesis", content: "# Summary\n- chlorophyll", subject_id: subject.id, topic_id: topic.id } });
  assert.equal(adminSave.status, 201, JSON.stringify(adminSave.body));
  assert.equal(adminSave.body.kind, "note");
  assert.equal(adminSave.body.note.source, "ai");

  const notes = (await call("GET", `/api/class-data/${cls.id}/topics/${topic.id}/notes`, { token: student.token })).body.notes;
  assert.ok(notes.some((n) => n.title === "AI Photosynthesis"));

  const studentSave = await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: student.token, body: { title: "My reviewer", content: "compact notes", subject_id: subject.id, topic_id: topic.id } });
  assert.equal(studentSave.status, 201);
  assert.equal(studentSave.body.kind, "upload");
  assert.equal(studentSave.body.upload.title, "My reviewer");

  assert.equal((await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: owner.token, body: { content: "no title" } })).status, 400);
});

test("quizzes: save, list, score an attempt, track attempts, and delete", async () => {
  const questions = [
    { question: "What does chlorophyll absorb?", options: ["Light", "Water", "Oxygen", "Sugar"], answer: 0, explanation: "It captures light energy." },
    { question: "Where does the Calvin cycle happen?", options: ["Thylakoid", "Stroma", "Nucleus", "Membrane"], answer: 1, explanation: "In the stroma of the chloroplast." }
  ];
  const saved = await call("POST", `/api/ai/${cls.id}/quizzes`, { token: owner.token, body: { title: "Photosynthesis quiz", difficulty: "easy", subject_id: subject.id, questions } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const quizId = saved.body.quiz.id;

  const list = (await call("GET", `/api/ai/${cls.id}/quizzes`, { token: student.token })).body.quizzes;
  const row = list.find((q) => q.id === quizId);
  assert.equal(row.question_count, 2);
  assert.equal(row.my_last, null);

  // One correct, one wrong.
  const attempt = await call("POST", `/api/ai/${cls.id}/quizzes/${quizId}/attempts`, { token: student.token, body: { answers: [0, 3] } });
  assert.equal(attempt.status, 201);
  assert.equal(attempt.body.attempt.score, 1);
  assert.equal(attempt.body.attempt.total, 2);
  assert.equal(attempt.body.review[0].is_correct, true);
  assert.equal(attempt.body.review[1].is_correct, false);

  // Unanswered questions count as wrong; out-of-range values are ignored.
  const blank = await call("POST", `/api/ai/${cls.id}/quizzes/${quizId}/attempts`, { token: student.token, body: { answers: ["x", 99] } });
  assert.equal(blank.body.attempt.score, 0);

  const attempts = (await call("GET", `/api/ai/${cls.id}/quizzes/${quizId}/attempts`, { token: student.token })).body.attempts;
  assert.equal(attempts.length, 2);

  const list2 = (await call("GET", `/api/ai/${cls.id}/quizzes`, { token: student.token })).body.quizzes;
  const last = list2.find((q) => q.id === quizId).my_last;
  assert.ok(last && last.total === 2);

  // Students can't delete someone else's quiz; the owner can.
  assert.equal((await call("DELETE", `/api/ai/${cls.id}/quizzes/${quizId}`, { token: student.token })).status, 403);
  assert.equal((await call("DELETE", `/api/ai/${cls.id}/quizzes/${quizId}`, { token: owner.token })).status, 200);
  assert.equal((await call("GET", `/api/ai/${cls.id}/quizzes/${quizId}`, { token: owner.token })).status, 404);
});

test("flashcards: needs a topic that belongs to the class", async () => {
  assert.equal((await call("POST", `/api/ai/${cls.id}/flashcards/generate`, { token: student.token, body: { topic_ids: [] } })).status, 400);
  const foreign = await call("POST", `/api/ai/${cls.id}/flashcards/generate`, { token: student.token, body: { topic_ids: ["00000000-0000-4000-8000-000000000000"] } });
  assert.equal(foreign.status, 400);
});

test("reviewers and quizzes are driven by subjects", async () => {
  // A reviewer must be saved under a subject.
  const noSubject = await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: owner.token, body: { title: "T", content: "c" } });
  assert.equal(noSubject.status, 400);
  assert.match(noSubject.body.error, /subject/i);

  // Generating a quiz or flashcards with nothing selected is rejected.
  assert.equal((await call("POST", `/api/ai/${cls.id}/quizzes/generate`, { token: owner.token, body: { subject_ids: [], topic_ids: [] } })).status, 400);
  assert.equal((await call("POST", `/api/ai/${cls.id}/flashcards/generate`, { token: owner.token, body: { subject_ids: [], topic_ids: [] } })).status, 400);

  // A student's subject-scoped save lands in that subject as their own note.
  const saved = await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: student.token, body: { title: "Subject note", content: "compact", subject_id: subject.id } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.kind, "upload");
  assert.equal(saved.body.upload.subject_id, subject.id);

  const listed = (await call("GET", `/api/class-data/${cls.id}/subjects/${subject.id}/reviewers`, { token: student.token })).body.reviewers;
  assert.ok(listed.some((r) => r.title === "Subject note"));

  // A subject that isn't in this class can't be saved to.
  assert.equal((await call("POST", `/api/ai/${cls.id}/reviewers/save`, { token: owner.token, body: { title: "T", content: "c", subject_id: "00000000-0000-4000-8000-000000000000" } })).status, 400);
});

test("students' uploaded reviewers count as source material for quizzes and flashcards", async () => {
  const p = `/api/class-data/${cls.id}`;
  // A brand-new subject that only ever gets a student's upload (no class notes).
  const solo = (await call("POST", `${p}/subjects`, { token: owner.token, body: { name: "Solo subject" } })).body.item;
  const saved = await call("POST", `/api/ai/${cls.id}/reviewers/save`, {
    token: student.token,
    body: { title: "Student note", content: "Key facts about the atom.", subject_id: solo.id }
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.kind, "upload");

  // The subject is not empty, so generation reaches the AI (503 here: no key in tests)
  // instead of the old "don't have any reviewers" 400 that ignored uploads.
  const quiz = await call("POST", `/api/ai/${cls.id}/quizzes/generate`, { token: owner.token, body: { subject_ids: [solo.id], count: 3 } });
  assert.equal(quiz.status, 503);
  assert.match(quiz.body.error, /AI/i);

  const flash = await call("POST", `/api/ai/${cls.id}/flashcards/generate`, { token: owner.token, body: { subject_id: solo.id } });
  assert.equal(flash.status, 503);
  assert.match(flash.body.error, /AI/i);
});

test("flashcards: study deck, spaced-repetition grading and due counts", async () => {
  const p = `/api/ai/${cls.id}`;
  // Seed two cards directly (generation needs the Gemini key, which tests don't set).
  const inserted = await pool.query(
    `INSERT INTO flashcards(class_id,subject_id,front,back,front_hash,created_by)
     VALUES ($1,$2,'What is mitosis?','Cell division','h1',$3), ($1,$2,'Define osmosis','Water movement','h2',$3)
     RETURNING id`,
    [cls.id, subject.id, owner.id]
  );
  const [cardA] = inserted.rows;

  // The deck starts with everything due (no review rows yet).
  const deck = await call("GET", `${p}/subjects/${subject.id}/flashcards`, { token: student.token });
  assert.equal(deck.status, 200);
  assert.equal(deck.body.total, 2);
  assert.equal(deck.body.due, 2);

  // Grading "again" keeps the card due right away.
  const again = await call("POST", `${p}/flashcards/${cardA.id}/review`, { token: student.token, body: { grade: 0 } });
  assert.equal(again.status, 200);
  assert.equal(again.body.review.reps, 0);

  // Grading "good" on the second rep schedules it into the future, so it is no longer due.
  await call("POST", `${p}/flashcards/${cardA.id}/review`, { token: student.token, body: { grade: 2 } });
  const good = await call("POST", `${p}/flashcards/${cardA.id}/review`, { token: student.token, body: { grade: 2 } });
  assert.equal(good.body.review.reps, 2);
  assert.ok(new Date(good.body.review.due_at).getTime() > Date.now());

  // Due counts reflect the graded card and the study streak has today recorded.
  const due = await call("GET", `${p}/study/due`, { token: student.token });
  assert.equal(due.status, 200);
  assert.equal(due.body.subjects.find((s) => s.id === subject.id).total, 2);
  assert.equal(due.body.subjects.find((s) => s.id === subject.id).due, 1);
  assert.equal(due.body.streak, 1);

  // A card can't be graded by someone outside the class.
  assert.equal((await call("POST", `${p}/flashcards/${cardA.id}/review`, { token: outsider?.token || "", body: { grade: 2 } })).status, 403);
});
