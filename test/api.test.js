// Integration tests: run against a REAL PostgreSQL database.
//   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/classlie_test JWT_SECRET=... npm test
// WARNING: this wipes all data in the TEST_DATABASE_URL database. Never point it at real data.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_test_secret_test_secret_123456";
const { createApp } = require("../src/app");

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error("Set TEST_DATABASE_URL to a throwaway database to run the tests."); process.exit(1); }

let pool, server, base, limitedServer, limitedBase;
const call = async (method, p, { token, body, raw, origin } = {}, b = base) => {
  const res = await fetch(b + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
};
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });

async function signup(name) {
  const r = await call("POST", "/api/auth/register", { body: { fullName: `${name} Tester`, username: name, email: `${name}@example.com`, password: "password123" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

before(async () => {
  pool = new Pool({ connectionString: url });
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));
  await pool.query("TRUNCATE users CASCADE");
  server = await listen(createApp(pool, { rateLimiting: false }));
  base = `http://127.0.0.1:${server.address().port}`;
  limitedServer = await listen(createApp(pool, { rateLimiting: true }));
  limitedBase = `http://127.0.0.1:${limitedServer.address().port}`;
});
after(async () => { server.close(); limitedServer.close(); await pool.end(); });

test("health, unknown API route, bad JSON, security headers", async () => {
  assert.deepEqual((await call("GET", "/api/health")).body, { ok: true, database: "connected" });
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.equal((await call("POST", "/api/auth/login", { raw: "{not json" })).status, 400);
  const h = await call("GET", "/api/health");
  assert.match(h.headers.get("content-security-policy"), /script-src 'self'/);
});

test("magic-link sign-in is removed", async () => {
  assert.equal((await call("POST", "/api/auth/magic", { body: { email: "ann@example.com" } })).status, 404);
  assert.equal((await call("POST", "/api/auth/magic/verify", { body: { token: "a".repeat(64) } })).status, 404);
});

test("registration validation, duplicates (case-insensitive), login by email and username", async () => {
  const bad = (body) => call("POST", "/api/auth/register", { body });
  const ok = { fullName: "Ann Lee", username: "ann_lee", email: "ann@example.com", password: "password123" };
  assert.equal((await bad({ ...ok, password: "short" })).status, 400);
  assert.equal((await bad({ ...ok, email: "nope" })).status, 400);
  assert.equal((await bad({ ...ok, username: "a b" })).status, 400);
  assert.equal((await bad({ ...ok, fullName: 123 })).status, 400);
  assert.equal((await bad({ ...ok, password: "x".repeat(80) })).status, 400);
  assert.equal((await bad(ok)).status, 201);
  assert.equal((await bad({ ...ok, username: "other", email: "ANN@example.com" })).status, 409);
  assert.equal((await bad({ ...ok, username: "ANN_LEE", email: "other@example.com" })).status, 409);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: "ann@example.com", password: "password123" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: "Ann_Lee", password: "password123" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: "ann_lee", password: "wrong-password" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: 5, password: {} } })).status, 400);
  const stored = (await pool.query("SELECT password_hash FROM users WHERE username='ann_lee'")).rows[0].password_hash;
  assert.ok(stored.startsWith("$2"), "password is bcrypt-hashed, not plaintext");
});

test("auth: missing/tampered tokens rejected, profile + password change", async () => {
  const u = await signup("prof");
  assert.equal((await call("GET", "/api/classes")).status, 401);
  assert.equal((await call("GET", "/api/classes", { token: u.token + "x" })).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { token: u.token })).body.user.username, "prof");
  const patched = await call("PATCH", "/api/auth/me", { token: u.token, body: { fullName: "New Name", username: "prof2" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.user.fullName, "New Name");
  assert.equal((await call("PATCH", "/api/auth/me", { token: u.token, body: { username: "ann_lee" } })).status, 409);
  assert.equal((await call("POST", "/api/auth/password", { token: u.token, body: { currentPassword: "nope", newPassword: "newpassword1" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/password", { token: u.token, body: { currentPassword: "password123", newPassword: "newpassword1" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: "prof2", password: "newpassword1" } })).status, 200);
});

test("rate limiting kicks in on repeated login attempts", async () => {
  let last;
  for (let i = 0; i < 32; i++) last = await call("POST", "/api/auth/login", { body: { login: "x", password: "y" } }, limitedBase);
  assert.equal(last.status, 429);
});

let owner, admin, student, outsider, cls, other;
test("classes: create, join by code, switch, roles", async () => {
  owner = await signup("owner1"); admin = await signup("admin1"); student = await signup("student1"); outsider = await signup("outsider1");
  assert.equal((await call("POST", "/api/classes", { token: owner.token, body: { name: "  " } })).status, 400);
  const created = await call("POST", "/api/classes", { token: owner.token, body: { name: "BSIT 2B", section: "2B", school: "PUP", academicYear: "2026-2027" } });
  assert.equal(created.status, 201);
  cls = created.body.class;
  assert.match(cls.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(cls.role, "owner");
  other = (await call("POST", "/api/classes", { token: outsider.token, body: { name: "Other class" } })).body.class;

  assert.equal((await call("POST", "/api/classes/join", { token: admin.token, body: { code: "ZZZZZZ" } })).status, 404);
  assert.equal((await call("POST", "/api/classes/join", { token: admin.token, body: {} })).status, 400);
  const joined = await call("POST", "/api/classes/join", { token: admin.token, body: { code: cls.code.toLowerCase() } });
  assert.equal(joined.body.class.role, "student");
  assert.equal(joined.body.alreadyMember, false);
  assert.equal((await call("POST", "/api/classes/join", { token: admin.token, body: { code: cls.code } })).body.alreadyMember, true);
  await call("POST", "/api/classes/join", { token: student.token, body: { code: cls.code } });

  const list = await call("GET", "/api/classes", { token: owner.token });
  assert.equal(list.body.classes.length, 1);
  assert.equal(list.body.classes[0].member_count, 3);

  // access boundaries
  assert.equal((await call("GET", `/api/classes/${cls.id}`, { token: outsider.token })).status, 403);
  assert.equal((await call("GET", `/api/classes/${cls.id}/members`, { token: outsider.token })).status, 403);
  assert.equal((await call("GET", `/api/class-data/${cls.id}/tasks`, { token: outsider.token })).status, 403);
  assert.equal((await call("GET", "/api/classes/not-a-uuid", { token: owner.token })).status, 400);

  // role management
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/members/${student.id}/role`, { token: admin.token, body: { role: "admin" } })).status, 403);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/members/${admin.id}/role`, { token: owner.token, body: { role: "owner" } })).status, 400);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/members/${admin.id}/role`, { token: owner.token, body: { role: "admin" } })).status, 200);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/members/${owner.id}/role`, { token: owner.token, body: { role: "student" } })).status, 400);

  // member list: emails only for admins
  const asStudent = (await call("GET", `/api/classes/${cls.id}/members`, { token: student.token })).body.members;
  const asAdmin = (await call("GET", `/api/classes/${cls.id}/members`, { token: admin.token })).body.members;
  assert.ok(asStudent.every((m) => m.email === undefined));
  assert.ok(asAdmin.every((m) => typeof m.email === "string"));
  assert.deepEqual(asAdmin.map((m) => m.role), ["owner", "admin", "student"]);

  // class details
  assert.equal((await call("PATCH", `/api/classes/${cls.id}`, { token: admin.token, body: { name: "Hacked" } })).status, 403);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}`, { token: owner.token, body: { section: "2C" } })).body.class.section, "2C");
});

test("only admins write class content; students read", async () => {
  const p = `/api/class-data/${cls.id}`;
  assert.equal((await call("POST", `${p}/subjects`, { token: student.token, body: { name: "Math" } })).status, 403);
  assert.equal((await call("POST", `${p}/tasks`, { token: student.token, body: { title: "x" } })).status, 403);
  assert.equal((await call("POST", `${p}/subjects`, { token: admin.token, body: { name: "" } })).status, 400);
  assert.equal((await call("POST", `${p}/subjects`, { token: admin.token, body: { name: "Math", color: "red; background:url(x)" } })).status, 400);
  const subj = await call("POST", `${p}/subjects`, { token: admin.token, body: { name: "Math", color: "#aabbcc" } });
  assert.equal(subj.status, 201);
  assert.equal((await call("GET", `${p}/subjects`, { token: student.token })).body.subjects.length, 1);
  assert.equal((await call("GET", `${p}/bogus`, { token: student.token })).status, 404);
  cls.subjectId = subj.body.item.id;
});

test("schedules: time-only values, validation, cross-class subject blocked", async () => {
  const p = `/api/class-data/${cls.id}/schedules`;
  const good = { title: "OOP", day_of_week: 1, start_time: "08:30", end_time: "10:00", room: " Lab 2 ", subject_id: cls.subjectId };
  const created = await call("POST", p, { token: admin.token, body: good });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.item.start_time, "08:30:00");
  assert.equal(created.body.item.room, "Lab 2");
  const id = created.body.item.id;

  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, end_time: "08:30" } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, end_time: "07:00" } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, start_time: "25:00" } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, day_of_week: 9 } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { title: "x" } })).status, 400);
  // a subject from someone else's class cannot be attached
  const foreign = (await call("POST", `/api/class-data/${other.id}/subjects`, { token: outsider.token, body: { name: "Secret" } })).body.item.id;
  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, subject_id: foreign } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { ...good, subject_id: "nope" } })).status, 400);

  // PATCH only end_time -> validated against the stored start_time
  assert.equal((await call("PATCH", `${p}/${id}`, { token: admin.token, body: { end_time: "08:00" } })).status, 400);
  const moved = await call("PATCH", `${p}/${id}`, { token: admin.token, body: { end_time: "11:15", day_of_week: "3" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.end_time, "11:15:00");
  assert.equal(moved.body.item.day_of_week, 3);
  const list = (await call("GET", p, { token: student.token })).body.schedules;
  assert.equal(list[0].start_time, "08:30:00");
});

test("tasks: individual completion per student, overdue data, cross-class safety", async () => {
  const p = `/api/class-data/${cls.id}/tasks`;
  assert.equal((await call("POST", p, { token: admin.token, body: { title: "T", priority: "urgent" } })).status, 400);
  assert.equal((await call("POST", p, { token: admin.token, body: { title: "T", due_at: "not a date" } })).status, 400);
  const t = await call("POST", p, { token: admin.token, body: { title: "Module 3", description: "Do it", due_at: "2026-10-20T08:00:00.000Z", priority: "high", subject_id: cls.subjectId } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const id = t.body.item.id;
  assert.equal(t.body.item.due_at.slice(0, 16), "2026-10-20T08:00");

  assert.equal((await call("PUT", `${p}/${id}/completion`, { token: student.token, body: { completed: true } })).status, 200);
  const seenByStudent = (await call("GET", p, { token: student.token })).body.tasks[0];
  const seenByAdmin = (await call("GET", p, { token: admin.token })).body.tasks[0];
  assert.equal(seenByStudent.completed, true);
  assert.equal(seenByAdmin.completed, false, "Student A completing must not complete it for others");
  assert.equal(seenByAdmin.completed_count, 1);
  await call("PUT", `${p}/${id}/completion`, { token: student.token, body: { completed: false } });
  assert.equal((await call("GET", p, { token: student.token })).body.tasks[0].completed, false);

  // non-member and cross-class attempts
  assert.equal((await call("PUT", `${p}/${id}/completion`, { token: outsider.token, body: { completed: true } })).status, 403);
  assert.equal((await call("PUT", `/api/class-data/${other.id}/tasks/${id}/completion`, { token: outsider.token, body: { completed: true } })).status, 404);
  assert.equal((await call("PATCH", `/api/class-data/${other.id}/tasks/${id}`, { token: outsider.token, body: { title: "pwned" } })).status, 404);
  assert.equal((await call("DELETE", `/api/class-data/${other.id}/tasks/${id}`, { token: outsider.token })).status, 404);
  assert.equal((await call("PATCH", `${p}/${id}`, { token: student.token, body: { title: "x" } })).status, 403);

  assert.equal((await call("PATCH", `${p}/${id}`, { token: admin.token, body: { due_at: "", subject_id: "" } })).body.item.due_at, null);
  assert.equal((await call("DELETE", `${p}/${id}`, { token: admin.token })).status, 200);
  assert.equal((await call("DELETE", `${p}/${id}`, { token: admin.token })).status, 404);
});

test("private tasks: only the creator can see, edit, complete or delete", async () => {
  const p = `/api/class-data/${cls.id}/tasks`;
  const made = await call("POST", `${p}/private`, { token: student.token, body: { title: "My secret", priority: "high" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.item.id;
  assert.equal(made.body.item.is_private, true);
  const studentList = (await call("GET", p, { token: student.token })).body.tasks;
  const adminList = (await call("GET", p, { token: admin.token })).body.tasks;
  assert.ok(studentList.some((t) => t.id === id), "creator sees their private task");
  assert.ok(!adminList.some((t) => t.id === id), "other members (even admins) don't see it");
  assert.equal((await call("PUT", `${p}/${id}/completion`, { token: admin.token, body: { completed: true } })).status, 404);
  assert.equal((await call("PUT", `${p}/${id}/completion`, { token: student.token, body: { completed: true } })).status, 200);
  assert.equal((await call("PATCH", `${p}/private/${id}`, { token: admin.token, body: { title: "hijack" } })).status, 404);
  assert.equal((await call("PATCH", `${p}/${id}`, { token: admin.token, body: { title: "hijack" } })).status, 404);
  assert.equal((await call("PATCH", `${p}/private/${id}`, { token: student.token, body: { title: "Renamed" } })).body.item.title, "Renamed");
  assert.equal((await call("DELETE", `${p}/private/${id}`, { token: admin.token })).status, 404);
  assert.equal((await call("DELETE", `${p}/private/${id}`, { token: student.token })).status, 200);
});

test("announcements feature is removed", async () => {
  const p = `/api/class-data/${cls.id}/announcements`;
  assert.equal((await call("GET", p, { token: student.token })).status, 404);
  assert.equal((await call("POST", p, { token: admin.token, body: { title: "x", body: "y" } })).status, 404);
});

test("subjects -> topics -> reviewer notes, with class isolation", async () => {
  const p = `/api/class-data/${cls.id}`;
  const subj = cls.subjectId;
  assert.equal((await call("POST", `${p}/subjects/${subj}/topics`, { token: student.token, body: { title: "x" } })).status, 403);
  assert.equal((await call("POST", `${p}/subjects/${subj}/topics`, { token: admin.token, body: { title: "" } })).status, 400);
  const t1 = (await call("POST", `${p}/subjects/${subj}/topics`, { token: admin.token, body: { title: "Topic 1" } })).body.topic;
  const t2 = (await call("POST", `${p}/subjects/${subj}/topics`, { token: admin.token, body: { title: "Topic 2" } })).body.topic;
  assert.equal(t2.sort_order, t1.sort_order + 1);
  assert.equal((await call("POST", `${p}/subjects/${subj}/topics`, { token: admin.token, body: { title: "x" } }, base)).status, 201);

  const n = await call("POST", `${p}/topics/${t1.id}/notes`, { token: admin.token, body: { title: "Key concepts", content: "<script>alert(1)</script>" } });
  assert.equal(n.status, 201);
  const topics = (await call("GET", `${p}/subjects/${subj}/topics`, { token: student.token })).body.topics;
  assert.equal(topics.find((t) => t.id === t1.id).note_count, 1);
  assert.equal((await call("GET", `${p}/topics/${t1.id}/notes`, { token: student.token })).body.notes[0].title, "Key concepts");

  // another class's admin cannot touch these via their own classId
  assert.equal((await call("GET", `/api/class-data/${other.id}/topics/${t1.id}/notes`, { token: outsider.token })).body.notes.length, 0);
  assert.equal((await call("PATCH", `/api/class-data/${other.id}/notes/${n.body.note.id}`, { token: outsider.token, body: { title: "x" } })).status, 404);
  assert.equal((await call("DELETE", `/api/class-data/${other.id}/notes/${n.body.note.id}`, { token: outsider.token })).status, 404);
  assert.equal((await call("PATCH", `/api/class-data/${other.id}/topics/${t1.id}`, { token: outsider.token, body: { title: "x" } })).status, 404);
  assert.equal((await call("POST", `/api/class-data/${other.id}/topics/${t1.id}/notes`, { token: outsider.token, body: { title: "x" } })).status, 404);

  const edited = await call("PATCH", `${p}/notes/${n.body.note.id}`, { token: admin.token, body: { title: "Renamed", content: "new" } });
  assert.equal(edited.body.note.title, "Renamed");
  assert.equal((await call("PATCH", `${p}/topics/${t1.id}`, { token: admin.token, body: { title: "Topic One" } })).body.topic.title, "Topic One");
  assert.equal((await call("DELETE", `${p}/notes/${n.body.note.id}`, { token: admin.token })).status, 200);
  assert.equal((await call("DELETE", `${p}/topics/${t2.id}`, { token: admin.token })).status, 200);

  // deleting a subject cascades to its topics
  assert.equal((await call("DELETE", `${p}/subjects/${subj}`, { token: admin.token })).status, 200);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM topics WHERE id=$1", [t1.id])).rows[0].n, 0);
});

test("removing members, leaving, deleting a class", async () => {
  const m = `/api/classes/${cls.id}/members`;
  assert.equal((await call("DELETE", `${m}/${student.id}`, { token: student.token })).status, 403);
  assert.equal((await call("DELETE", `${m}/${owner.id}`, { token: admin.token })).status, 400);
  assert.equal((await call("DELETE", `${m}/${admin.id}`, { token: admin.token })).status, 403);
  assert.equal((await call("DELETE", `/api/classes/${cls.id}/leave`, { token: owner.token })).status, 400);
  assert.equal((await call("DELETE", `${m}/${student.id}`, { token: admin.token })).status, 200);
  assert.equal((await call("GET", `/api/class-data/${cls.id}/tasks`, { token: student.token })).status, 403);
  assert.equal((await call("DELETE", `/api/classes/${cls.id}/leave`, { token: admin.token })).status, 200);
  assert.equal((await call("DELETE", `/api/classes/${cls.id}`, { token: outsider.token })).status, 403);
  assert.equal((await call("DELETE", `/api/classes/${cls.id}`, { token: owner.token })).status, 200);
  assert.equal((await call("GET", "/api/classes", { token: owner.token })).body.classes.length, 0);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM schedules WHERE class_id=$1", [cls.id])).rows[0].n, 0);
});
