async function getMembership(db, classId, userId) {
  const result = await db.query(
    "SELECT role FROM class_members WHERE class_id = $1 AND user_id = $2",
    [classId, userId]
  );
  return result.rows[0] || null;
}

async function requireClassMember(req, res, next) {
  try {
    const membership = await getMembership(req.app.locals.db, req.params.classId, req.user.id);
    if (!membership) return res.status(403).json({ error: "You are not a member of this class." });
    req.membership = membership;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireClassAdmin(req, res, next) {
  try {
    const membership = await getMembership(req.app.locals.db, req.params.classId, req.user.id);
    if (!membership) return res.status(403).json({ error: "You are not a member of this class." });
    if (!["owner", "admin"].includes(membership.role)) return res.status(403).json({ error: "Only class admins can do that." });
    req.membership = membership;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { getMembership, requireClassMember, requireClassAdmin };
