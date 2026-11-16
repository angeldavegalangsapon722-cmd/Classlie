// Attendance + student uploads. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/classlie_test JWT_SECRET=... npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_test_secret_test_secret_123456";
const { createApp } = require("../src/app");

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error("Set TEST_DATABASE_URL to a throwaway database to run the tests."); process.exit(1); }

let pool, server, base, owner, member, other, cls;
const call = async (method, p, { token, body, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) { payload = form; } else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers, body: payload });
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
  owner = await signup("attowner"); member = await signup("attmember"); other = await signup("attother");
  const created = await call("POST", "/api/classes", { token: owner.token, body: { name: "Attendance Class" } });
  cls = created.body.class;
  await call("POST", "/api/classes/join", { token: member.token, body: { code: cls.code } });
  await call("POST", "/api/classes/join", { token: other.token, body: { code: cls.code } });
});
after(async () => { server.close(); await pool.end(); });

const nextWeekday = (want) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((want - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

test("attendance: admins create recurring and one-off sessions", async () => {
  const monday = nextWeekday(1);
  const weekly = await call("POST", `/api/attendance/${cls.id}/sessions`, { token: owner.token, body: { name: "Flag ceremony", kind: "weekly", days: [1] } });
  assert.equal(weekly.status, 201, JSON.stringify(weekly.body));
  assert.deepEqual(weekly.body.session.days, [1]);

  const event = await call("POST", `/api/attendance/${cls.id}/sessions`, { token: owner.token, body: { name: "Foundation Day", kind: "date", event_date: monday } });
  assert.equal(event.status, 201);
  assert.equal(event.body.session.event_date.slice(0, 10), monday);

  assert.equal((await call("POST", `/api/attendance/${cls.id}/sessions`, { token: member.token, body: { name: "Nope", kind: "weekly", days: [2] } })).status, 403);
  assert.equal((await call("POST", `/api/attendance/${cls.id}/sessions`, { token: owner.token, body: { name: "Bad", kind: "weekly", days: [] } })).status, 400);
  assert.equal((await call("POST", `/api/attendance/${cls.id}/sessions`, { token: owner.token, body: { name: "Bad", kind: "date" } })).status, 400);

  const day = await call("GET", `/api/attendance/${cls.id}/day?date=${monday}`, { token: member.token });
  assert.equal(day.status, 200);
  const names = day.body.sessions.map((s) => s.name).sort();
  assert.deepEqual(names, ["Flag ceremony", "Foundation Day"]);

  const tuesday = nextWeekday(2);
  const off = await call("GET", `/api/attendance/${cls.id}/day?date=${tuesday}`, { token: member.token });
  assert.deepEqual(off.body.sessions, []);
});

test("attendance: only the scheduled day can be marked, and students can read their own status", async () => {
  const sessions = (await call("GET", `/api/attendance/${cls.id}/sessions`, { token: owner.token })).body.sessions;
  const flag = sessions.find((s) => s.name === "Flag ceremony");
  const monday = nextWeekday(1);
  const tuesday = nextWeekday(2);

  const roster = await call("GET", `/api/attendance/${cls.id}/sessions/${flag.id}?date=${monday}`, { token: member.token });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.occurs, true);
  assert.equal(roster.body.canMark, false);
  assert.ok(roster.body.members.find((m) => m.id === member.id));

  const offDay = await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, { token: owner.token, body: { date: tuesday, records: [{ userId: member.id, status: "present" }] } });
  assert.equal(offDay.status, 400);

  assert.equal((await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, { token: member.token, body: { date: monday, records: [] } })).status, 403);

  const save = await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, {
    token: owner.token,
    body: { date: monday, records: [{ userId: member.id, status: "late" }, { userId: other.id, status: "absent" }] }
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));

  const after = await call("GET", `/api/attendance/${cls.id}/sessions/${flag.id}?date=${monday}`, { token: member.token });
  assert.equal(after.body.members.find((m) => m.id === member.id).status, "late");
  assert.equal(after.body.members.find((m) => m.id === other.id).status, "absent");

  assert.equal((await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, { token: owner.token, body: { date: monday, records: [{ userId: member.id, status: "napping" }] } })).status, 400);
  assert.equal((await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, { token: owner.token, body: { date: monday, records: [{ userId: "not-a-uuid", status: "present" }] } })).status, 400);

  const clear = await call("PUT", `/api/attendance/${cls.id}/sessions/${flag.id}/records`, { token: owner.token, body: { date: monday, records: [{ userId: member.id, status: null }] } });
  assert.equal(clear.status, 200);
  const cleared = await call("GET", `/api/attendance/${cls.id}/sessions/${flag.id}?date=${monday}`, { token: member.token });
  assert.equal(cleared.body.members.find((m) => m.id === member.id).status, null);

  assert.equal((await call("DELETE", `/api/attendance/${cls.id}/sessions/${flag.id}`, { token: member.token })).status, 403);
  assert.equal((await call("DELETE", `/api/attendance/${cls.id}/sessions/${flag.id}`, { token: owner.token })).status, 200);
});

test("attendance summary: a student sees their own rate, admins can view others", async () => {
  const thursday = nextWeekday(4);
  const nextThursday = (() => { const d = new Date(`${thursday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })();
  const session = (await call("POST", `/api/attendance/${cls.id}/sessions`, { token: owner.token, body: { name: "Homeroom", kind: "weekly", days: [4] } })).body.session;

  await call("PUT", `/api/attendance/${cls.id}/sessions/${session.id}/records`, { token: owner.token, body: { date: thursday, records: [{ userId: member.id, status: "present" }] } });
  await call("PUT", `/api/attendance/${cls.id}/sessions/${session.id}/records`, { token: owner.token, body: { date: nextThursday, records: [{ userId: member.id, status: "absent" }] } });

  const mine = await call("GET", `/api/attendance/${cls.id}/attendance/summary`, { token: member.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.overall.present, 1);
  assert.equal(mine.body.overall.absent, 1);
  assert.equal(mine.body.overall.rate, 50);
  assert.equal(mine.body.member.id, member.id);

  // An admin can inspect another member.
  const asAdmin = await call("GET", `/api/attendance/${cls.id}/attendance/summary?userId=${member.id}`, { token: owner.token });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.body.overall.rate, 50);

  // A student cannot inspect someone else.
  assert.equal((await call("GET", `/api/attendance/${cls.id}/attendance/summary?userId=${other.id}`, { token: member.token })).status, 403);
});

test("uploads: students upload text and files, and can only delete their own", async () => {
  const form = new FormData();
  form.set("title", "My reviewer");
  form.set("content", "Chapter 1 summary");
  const created = await call("POST", `/api/uploads/${cls.id}`, { token: member.token, form });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const uploadId = created.body.upload.id;

  const fileForm = new FormData();
  fileForm.set("title", "Scanned notes");
  fileForm.set("file", new Blob([Buffer.from("hello pdf")], { type: "application/pdf" }), "notes.pdf");
  const withFile = await call("POST", `/api/uploads/${cls.id}`, { token: member.token, form: fileForm });
  assert.equal(withFile.status, 201);
  assert.equal(withFile.body.upload.file_name, "notes.pdf");
  assert.equal(withFile.body.upload.file_size, 9);

  const listed = await call("GET", `/api/uploads/${cls.id}`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.uploads.length, 2);
  assert.equal(listed.body.uploads.find((u) => u.id === uploadId).username, "attmember");

  const download = await call("GET", `/api/uploads/${cls.id}/${withFile.body.upload.id}/file`, { token: owner.token });
  assert.equal(download.status, 200);

  const empty = await call("POST", `/api/uploads/${cls.id}`, { token: member.token, form: (() => { const f = new FormData(); f.set("title", "Nothing"); return f; })() });
  assert.equal(empty.status, 400);

  assert.equal((await call("DELETE", `/api/uploads/${cls.id}/${uploadId}`, { token: other.token })).status, 403);
  assert.equal((await call("DELETE", `/api/uploads/${cls.id}/${uploadId}`, { token: member.token })).status, 200);
  assert.equal((await call("DELETE", `/api/uploads/${cls.id}/${withFile.body.upload.id}`, { token: owner.token })).status, 200);
});

test("reviewers live directly under a subject: combined list, summary, edit and delete", async () => {
  const p = `/api/class-data/${cls.id}`;
  const subject = (await call("POST", `${p}/subjects`, { token: owner.token, body: { name: "Physics" } })).body.item;
  assert.equal(subject.name, "Physics");

  // A student files their own note under the subject.
  const studentForm = new FormData();
  studentForm.set("title", "Waves note");
  studentForm.set("content", "Frequency and wavelength");
  studentForm.set("subject_id", subject.id);
  const upload = (await call("POST", `/api/uploads/${cls.id}`, { token: member.token, form: studentForm })).body.upload;
  assert.equal(upload.subject_id, subject.id);

  // The admin adds a class reviewer under the same subject.
  const note = (await call("POST", `${p}/subjects/${subject.id}/notes`, { token: owner.token, body: { title: "Optics reviewer", content: "Laws of reflection" } })).body.note;
  assert.equal(note.subject_id, subject.id);

  // One combined list, newest first, with both kinds.
  const list = (await call("GET", `${p}/subjects/${subject.id}/reviewers`, { token: member.token })).body.reviewers;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((r) => r.kind).sort(), ["note", "upload"]);
  assert.ok(list.every((r) => r.full_name && r.created_at));

  // The dashboard counts add up.
  const summary = (await call("GET", `${p}/reviewer-summary`, { token: member.token })).body.summary;
  assert.equal(summary[subject.id], 2);

  // Students can't create or edit class reviewers.
  assert.equal((await call("POST", `${p}/subjects/${subject.id}/notes`, { token: member.token, body: { title: "Nope", content: "x" } })).status, 403);
  assert.equal((await call("PATCH", `${p}/notes/${note.id}`, { token: member.token, body: { title: "Hijack", content: "x" } })).status, 403);

  // Admin can edit it, and it stays under the subject.
  const edited = await call("PATCH", `${p}/notes/${note.id}`, { token: owner.token, body: { title: "Optics v2", content: "Updated laws" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.note.title, "Optics v2");
  assert.equal(edited.body.note.subject_id, subject.id);

  // Deleting drops it from the list and the count.
  assert.equal((await call("DELETE", `${p}/notes/${note.id}`, { token: owner.token })).status, 200);
  const after = (await call("GET", `${p}/subjects/${subject.id}/reviewers`, { token: member.token })).body.reviewers;
  assert.equal(after.length, 1);
  assert.equal(after[0].kind, "upload");
  assert.equal((await call("GET", `${p}/reviewer-summary`, { token: member.token })).body.summary[subject.id], 1);

  // A subject id that isn't in this class 404s.
  assert.equal((await call("GET", `${p}/subjects/00000000-0000-4000-8000-000000000000/reviewers`, { token: member.token })).status, 404);
});
