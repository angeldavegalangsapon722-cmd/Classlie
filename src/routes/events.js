const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { isUuid } = require("../middleware/validate");

router.use(requireAuth);

// Lightweight product analytics: the client reports a small, fixed set of
// activation events so we can see where people drop off. Fire-and-forget.
const MAX_NAME = 60;
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, MAX_NAME);
    if (!name) return res.status(400).json({ error: "An event name is required." });
    const classId = isUuid(req.body?.classId) ? req.body.classId : null;
    let props = null;
    if (req.body?.props && typeof req.body.props === "object") {
      try { props = JSON.stringify(req.body.props).slice(0, 2000); } catch { props = null; }
    }
    await req.app.locals.db.query(
      "INSERT INTO events (user_id, class_id, name, props) VALUES ($1,$2,$3,$4)",
      [req.user.id, classId, name, props]
    );
    res.status(204).end();
  } catch (error) { next(error); }
});

module.exports = router;
