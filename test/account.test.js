// Password reset tests. Run with:
//   TEST_DATABASE_URL=postgresql://postgres:pw@localhost:5432/classlie_test JWT_SECRET=... npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
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
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

before(async () => {
  pool = new Pool({ connectionString: url });
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8"));
  await pool.query("TRUNCATE users CASCADE");
  server = await listen(createApp(pool, { rateLimiting: false }));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

test("forgot password never reveals whether an email is registered", async () => {
  await call("POST", "/api/auth/register", { body: { fullName: "Reset User", username: "resetter", email: "reset@example.com", password: "password123" } });
  const known = await call("POST", "/api/auth/forgot", { body: { email: "reset@example.com" } });
  const unknown = await call("POST", "/api/auth/forgot", { body: { email: "nobody@example.com" } });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, { ok: true });
  assert.deepEqual(unknown.body, { ok: true });
  assert.equal((await call("POST", "/api/auth/forgot", { body: { email: "not-an-email" } })).status, 400);
});

test("reset rejects bad or expired tokens", async () => {
  assert.equal((await call("POST", "/api/auth/reset", { body: { token: "nope", password: "password123" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/reset", { body: { token: "a".repeat(64), password: "password123" } })).status, 400);
  const shortPw = await call("POST", "/api/auth/reset", { body: { token: "a".repeat(64), password: "short" } });
  assert.equal(shortPw.status, 400);
});

test("a valid reset token changes the password and can only be used once", async () => {
  const user = (await pool.query("SELECT id FROM users WHERE email='reset@example.com'")).rows[0];
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,NOW() + INTERVAL '30 minutes')",
    [user.id, hash(token)]
  );

  const reset = await call("POST", "/api/auth/reset", { body: { token, password: "brandnew123" } });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { ok: true });

  assert.equal((await call("POST", "/api/auth/login", { body: { login: "reset@example.com", password: "password123" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { login: "reset@example.com", password: "brandnew123" } })).status, 200);

  assert.equal((await call("POST", "/api/auth/reset", { body: { token, password: "anotherone1" } })).status, 400);
});

test("an expired reset token is refused", async () => {
  const user = (await pool.query("SELECT id FROM users WHERE email='reset@example.com'")).rows[0];
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,NOW() - INTERVAL '1 minute')",
    [user.id, hash(token)]
  );
  assert.equal((await call("POST", "/api/auth/reset", { body: { token, password: "password123" } })).status, 400);
});
