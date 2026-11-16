const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { uuidParams } = require("../middleware/validate");
const { generateDueSoon } = require("../notify");
const { pushConfigured, publicKey } = require("../push");

router.use(requireAuth);
uuidParams(router, "id");

// Whether web push is available, and the key the browser needs to subscribe.
router.get("/push/key", (_req, res) => {
  res.json({ enabled: pushConfigured(), publicKey: publicKey() });
});

router.post("/push/subscribe", async (req, res, next) => {
  try {
    if (!pushConfigured()) return res.status(503).json({ error: "Push notifications aren't configured on this server." });
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || "");
    const p256dh = String(sub.keys?.p256dh || "");
    const auth = String(sub.keys?.auth || "");
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "That push subscription looks incomplete." });
    const timezone = String(req.body?.timezone || "UTC").slice(0, 80);
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
    catch { return res.status(400).json({ error: "That time zone is not valid." }); }
    await req.app.locals.db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, timezone) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4, timezone=$5`,
      [req.user.id, endpoint, p256dh, auth, timezone]
    );
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete("/push/subscribe", async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || "");
    if (endpoint) await req.app.locals.db.query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2", [req.user.id, endpoint]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get("/", async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await generateDueSoon(db, req.user.id);
    const result = await db.query(
      `SELECT n.*, c.name AS class_name
       FROM notifications n JOIN classes c ON c.id = n.class_id
       WHERE n.user_id = $1
       ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC
       LIMIT 60`,
      [req.user.id]
    );
    const unread = result.rows.filter((n) => !n.read_at).length;
    res.json({ notifications: result.rows, unread });
  } catch (error) { next(error); }
});

router.patch("/:id/read", async (req, res, next) => {
  try {
    const result = await req.app.locals.db.query(
      "UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Notification not found." });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/read-all", async (req, res, next) => {
  try {
    await req.app.locals.db.query("UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL", [req.user.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
