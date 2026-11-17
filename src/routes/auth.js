const crypto = require("crypto");
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { requireAuth } = require("../middleware/auth");
const { badRequest, HttpError } = require("../middleware/errors");
const { cleanText } = require("../middleware/validate");
const { sendMail } = require("../mailer");
const { logActiveStatus } = require("../activity");

const MAX_AVATAR_BYTES = 1024 * 1024; // 1 MB, stored inline as a data URL
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });
const uploadAvatar = (req, res, next) => avatarUpload.single("avatar")(req, res, (err) => {
  if (err) return next(err.code === "LIMIT_FILE_SIZE" ? badRequest("Your photo must be 1 MB or smaller.") : err);
  next();
});

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Only a hash of the emailed token is stored; the raw token never touches the database.
const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d", algorithm: "HS256" });
}
function publicUser(user) {
  return { id: user.id, fullName: user.full_name, username: user.username, email: user.email, avatarUrl: user.avatar_url, activeStatus: user.active_status !== false };
}
function checkPassword(password, label = "Password") {
  if (typeof password !== "string" || password.length < 8) throw badRequest(`${label} must be at least 8 characters.`);
  if (Buffer.byteLength(password) > 72) throw badRequest(`${label} must be 72 bytes or fewer.`);
}
function checkUsername(username) {
  if (!USERNAME_RE.test(username)) throw badRequest("Username must be 3–30 characters and use only letters, numbers, and underscores.");
}

router.post("/register", async (req, res, next) => {
  try {
    const body = req.body || {};
    const fullName = cleanText(body.fullName, "Full name", 100, { required: true });
    const username = cleanText(body.username, "Username", 30, { required: true });
    const email = cleanText(body.email, "Email", 255, { required: true }).toLowerCase();
    checkUsername(username);
    if (!EMAIL_RE.test(email)) throw badRequest("Enter a valid email address.");
    checkPassword(body.password);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const result = await req.app.locals.db.query(
      "INSERT INTO users (full_name, username, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING *",
      [fullName, username, email, passwordHash]
    );
    const user = result.rows[0];
    res.status(201).json({ token: makeToken(user), user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return next(new HttpError(409, "That email or username is already registered."));
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { login, password } = req.body || {};
    if (typeof login !== "string" || typeof password !== "string" || !login.trim() || !password) {
      throw badRequest("Enter your email/username and password.");
    }
    const result = await req.app.locals.db.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1) LIMIT 1",
      [login.trim()]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect login details." });
    }
    res.json({ token: makeToken(user), user: publicUser(user) });
  } catch (error) { next(error); }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      "SELECT id, full_name, username, email, avatar_url, active_status FROM users WHERE id=$1", [req.user.id]
    );
    if (!result.rows[0]) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) { next(error); }
});

router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [];
    if (body.fullName !== undefined) {
      params.push(cleanText(body.fullName, "Full name", 100, { required: true }));
      sets.push(`full_name=$${params.length}`);
    }
    if (body.username !== undefined) {
      const username = cleanText(body.username, "Username", 30, { required: true });
      checkUsername(username);
      params.push(username);
      sets.push(`username=$${params.length}`);
    }
    if (body.activeStatus !== undefined) {
      if (typeof body.activeStatus !== "boolean") throw badRequest("Active Status must be on or off.");
      await logActiveStatus(req.app.locals.db, { userId: req.user.id, active: body.activeStatus });
      if (body.fullName === undefined && body.username === undefined) {
        const updated = await req.app.locals.db.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
        return res.json({ user: publicUser(updated.rows[0]), token: makeToken(updated.rows[0]) });
      }
    }
    if (!sets.length) throw badRequest("Nothing to update.");
    params.push(req.user.id);
    const result = await req.app.locals.db.query(
      `UPDATE users SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params
    );
    if (!result.rows[0]) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
    res.json({ user: publicUser(result.rows[0]), token: makeToken(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return next(new HttpError(409, "That username is already taken."));
    next(error);
  }
});

router.post("/avatar", requireAuth, uploadAvatar, async (req, res, next) => {
  try {
    if (!req.file) throw badRequest("Choose an image to upload.");
    if (!/^image\//.test(req.file.mimetype || "")) throw badRequest("Your profile photo must be an image.");
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const result = await req.app.locals.db.query(
      "UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING *", [dataUrl, req.user.id]
    );
    if (!result.rows[0]) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) { next(error); }
});

router.delete("/avatar", requireAuth, async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      "UPDATE users SET avatar_url=NULL WHERE id=$1 RETURNING *", [req.user.id]
    );
    if (!result.rows[0]) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) { next(error); }
});

router.post("/password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    checkPassword(newPassword, "New password");
    const db = req.app.locals.db;
    const found = await db.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (!found.rows[0]) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
    if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, found.rows[0].password_hash))) {
      return res.status(400).json({ error: "Your current password is incorrect." });
    }
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(newPassword, 12), req.user.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Always answers the same way, whether or not the email exists (no account enumeration).
router.post("/forgot", async (req, res, next) => {
  try {
    const email = cleanText(req.body?.email, "Email", 255, { required: true }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw badRequest("Enter a valid email address.");
    const configured = process.env.APP_URL || process.env.PUBLIC_URL;
    if (!configured) throw new HttpError(503, "Password reset is not configured on this server.");
    const db = req.app.locals.db;
    const found = (await db.query("SELECT id, full_name, email FROM users WHERE LOWER(email)=LOWER($1)", [email])).rows[0];
    if (found) {
      const token = crypto.randomBytes(32).toString("hex");
      await db.query("DELETE FROM password_resets WHERE user_id=$1", [found.id]);
      await db.query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,NOW() + INTERVAL '30 minutes')",
        [found.id, hashResetToken(token)]
      );
      const base = configured.replace(/\/$/, "");
      const link = `${base}/?reset=${token}`;
      const name = escapeHtml(found.full_name || "there");
      try {
        await sendMail({
          to: found.email,
          subject: "Reset your Classlie password",
          text: `Hi ${found.full_name || "there"},\n\nUse this link within 30 minutes to choose a new password:\n${link}\n\nIf you didn't ask for this, you can safely ignore this email.`,
          html: `<p>Hi ${name},</p><p>Use the link below within 30 minutes to choose a new password:</p><p><a href="${link}">Reset your password</a></p><p>If you didn't ask for this, you can safely ignore this email.</p>`
        });
      } catch (error) {
        console.error("Could not send reset email:", error.message);
      }
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/reset", async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!/^[0-9a-f]{64}$/i.test(token)) throw badRequest("This reset link is not valid.");
    checkPassword(req.body?.password, "Password");
    const db = req.app.locals.db;
    const row = (await db.query(
      "SELECT id, user_id FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > NOW()",
      [hashResetToken(token)]
    )).rows[0];
    if (!row) throw badRequest("This reset link is invalid or has expired. Request a new one.");
    const passwordHash = await bcrypt.hash(req.body.password, 12);
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [passwordHash, row.user_id]);
    await db.query("DELETE FROM password_resets WHERE user_id=$1", [row.user_id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
