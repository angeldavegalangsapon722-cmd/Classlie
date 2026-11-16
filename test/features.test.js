// Tests for Round 1 additions: ownership transfer, activity log, search, notifications.
// Run with: TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/classlie_test JWT_SECRET=... npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_test_secret_test_secret_123456";
const { createApp } = require("../src/app");

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
const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
async function signup(name) {
  const r = await call("POST", "/api/auth/register", { body: { fullName: `${name} Tester`, username: name, email: `${name}@example.com`, password: "password123" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

let owner, admin, student, cls;
before(async () => {
  pool = new Pool({ connectionString: url });
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));
  await pool.query("TRUNCATE users CASCADE");
  server = await listen(createApp(pool, { rateLimiting: false }));
  base = `http://127.0.0.1:${server.address().port}`;

  owner = await signup("own2"); admin = await signup("adm2"); student = await signup("stu2");
  const created = await call("POST", "/api/classes", { token: owner.token, body: { name: "Search Class" } });
  cls = created.body.class;
  await call("POST", "/api/classes/join", { token: admin.token, body: { code: cls.code } });
  await call("POST", "/api/classes/join", { token: student.token, body: { code: cls.code } });
});
after(async () => { server.close(); await pool.end(); });

test("ownership transfer: only the owner can hand the class over", async () => {
  const asAdmin = await call("PATCH", `/api/classes/${cls.id}/owner`, { token: admin.token, body: { userId: student.id } });
  assert.equal(asAdmin.status, 403);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/owner`, { token: owner.token, body: { userId: owner.id } })).status, 400);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/owner`, { token: owner.token, body: { userId: "not-a-uuid" } })).status, 400);
  assert.equal((await call("PATCH", `/api/classes/${cls.id}/owner`, { token: owner.token, body: { userId: (await signup("nost")).id } })).status, 404);

  assert.equal((await call("PATCH", `/api/classes/${cls.id}/owner`, { token: owner.token, body: { userId: admin.id } })).status, 200);
  const members = (await call("GET", `/api/classes/${cls.id}/members`, { token: admin.token })).body.members;
  assert.equal(members.find((m) => m.id === admin.id).role, "owner");
  assert.equal(members.find((m) => m.id === owner.id).role, "admin");
  const row = (await pool.query("SELECT created_by FROM classes WHERE id=$1", [cls.id])).rows[0];
  assert.equal(row.created_by, admin.id);

  await call("PATCH", `/api/classes/${cls.id}/owner`, { token: admin.token, body: { userId: owner.id } });
});

test("activity log records create/update/delete and member changes", async () => {
  const p = `/api/class-data/${cls.id}`;
  const subj = await call("POST", `${p}/subjects`, { token: owner.token, body: { name: "Data Structures" } });
  assert.equal(subj.status, 201);
  const subjectId = subj.body.item.id;
  const task = await call("POST", `${p}/tasks`, { token: owner.token, body: { title: "Graph traversal", subject_id: subjectId } });
  assert.equal(task.status, 201);
  await call("PATCH", `${p}/tasks/${task.body.item.id}`, { token: owner.token, body: { title: "BFS traversal" } });
  await call("DELETE", `${p}/tasks/${task.body.item.id}`, { token: owner.token });

  await call("PATCH", `/api/classes/${cls.id}/members/${student.id}/role`, { token: owner.token, body: { role: "admin" } });

  const activity = (await call("GET", `/api/classes/${cls.id}/activity`, { token: admin.token })).body.activity;
  const summaries = activity.map((a) => a.summary);
  assert.ok(summaries.some((s) => s.includes("added subject") && s.includes("Data Structures")));
  assert.ok(summaries.some((s) => s.includes("BFS traversal")));
  assert.ok(summaries.some((s) => s.includes("deleted task")));
  assert.ok(summaries.some((s) => s.includes("role to admin")));
  assert.ok(activity.every((a) => a.username));
});

test("search finds tasks, notes and subjects across the class", async () => {
  const p = `/api/class-data/${cls.id}`;
  await call("POST", `${p}/tasks`, { token: owner.token, body: { title: "Quarterly report", description: "Write up the findings" } });
  const topic = (await call("POST", `${p}/subjects/${(await call("POST", `${p}/subjects`, { token: owner.token, body: { name: "Biology" } })).body.item.id}/topics`, { token: owner.token, body: { title: "Cell division" } })).body.topic;
  await call("POST", `${p}/topics/${topic.id}/notes`, { token: owner.token, body: { title: "Mitosis notes", content: "Remember the phases of mitosis" } });

  const r = await call("GET", `${p}/search?q=mitosis`, { token: student.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.notes[0].title, "Mitosis notes");
  assert.equal(r.body.results.tasks.length, 0);

  const r2 = await call("GET", `${p}/search?q=report`, { token: student.token });
  assert.equal(r2.body.results.tasks[0].title, "Quarterly report");

  const r4 = await call("GET", `${p}/search`, { token: student.token });
  assert.deepEqual(r4.body.results.notes, []);
  assert.equal(r4.body.results.announcements, undefined);

  assert.equal((await call("GET", `/api/class-data/${cls.id}/search?q=x`, { token: owner.token })).status, 200);
});

test("notifications: members get task alerts and due-soon reminders", async () => {
  const p = `/api/class-data/${cls.id}`;
  await call("POST", `${p}/tasks`, { token: owner.token, body: { title: "Quiz tomorrow", due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() } });

  const mine = (await call("GET", "/api/notifications", { token: owner.token })).body;
  const students = (await call("GET", "/api/notifications", { token: student.token })).body;
  assert.ok(!mine.notifications.some((n) => n.type === "task"), "authors are not notified about their own posts");
  const types = students.notifications.map((n) => n.type);
  assert.ok(types.includes("task"));
  assert.ok(types.includes("due_soon"));
  assert.ok(students.unread >= 2);
  assert.ok(students.notifications.every((n) => n.class_name === "Search Class"));

  const first = students.notifications[0];
  assert.equal((await call("PATCH", `/api/notifications/${first.id}/read`, { token: student.token })).status, 200);
  const afterRead = (await call("GET", "/api/notifications", { token: student.token })).body;
  assert.equal(afterRead.unread, students.unread - 1);
  assert.equal((await call("PATCH", `/api/notifications/${first.id}/read`, { token: owner.token })).status, 404);

  assert.equal((await call("POST", "/api/notifications/read-all", { token: student.token })).status, 200);
  assert.equal((await call("GET", "/api/notifications", { token: student.token })).body.unread, 0);
});

test("schedule import: admins only, normalizes times, and auto-creates subjects", async () => {
  const p = `/api/class-data/${cls.id}/schedules`;
  const student2 = await signup("stu3");
  await call("POST", "/api/classes/join", { token: student2.token, body: { code: cls.code } });
  assert.equal((await call("POST", `${p}/import`, { token: student2.token, body: { entries: [{ title: "Nope", day: 1, start_time: "08:00", end_time: "09:00" }] } })).status, 403);

  const entries = [
    { title: "Object-Oriented Programming", subject: "OOP", day: "Monday", start_time: "7:30 AM", end_time: "9:00 AM", room: "Lab 2" },
    { title: "Data Structures", subject: "OOP", day: 3, start_time: "13:00", end_time: "14:30", room: "" },
    { title: "Bad row", day: "Funday", start_time: "09:00", end_time: "10:00" }
  ];
  const bad = await call("POST", `${p}/import`, { token: owner.token, body: { entries } });
  assert.equal(bad.status, 400, "invalid day is rejected");

  const ok = await call("POST", `${p}/import`, { token: owner.token, body: { entries: entries.slice(0, 2) } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.imported, 2);
  assert.equal(ok.body.schedules[0].start_time, "07:30:00", "12-hour time normalized to 24-hour");
  assert.equal(ok.body.schedules[0].day_of_week, 1);

  const subjects = (await call("GET", `/api/class-data/${cls.id}/subjects`, { token: owner.token })).body.subjects;
  const oop = subjects.filter((s) => s.name.toLowerCase() === "oop");
  assert.equal(oop.length, 1, "the shared subject is created once, not duplicated");
  assert.ok(ok.body.schedules.every((s) => s.subject_id === oop[0].id), "both entries link to the auto-created subject");

  assert.equal((await call("POST", `${p}/import`, { token: owner.token, body: { entries: [] } })).status, 400);
});