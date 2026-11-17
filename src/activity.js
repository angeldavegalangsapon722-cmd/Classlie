async function logActivity(db, { classId, userId, action, entityType, entityId = null, summary }) {
  try {
    await db.query(
      `INSERT INTO activity_log (class_id, user_id, action, entity_type, entity_id, summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [classId, userId, action, entityType, entityId, summary]
    );
    await db.query("UPDATE users SET last_active_at=NOW() WHERE id=$1", [userId]);
  } catch (error) {
    console.error("Could not write activity log:", error.message);
  }
}

async function logActiveStatus(db, { userId, active }) {
  await db.query("UPDATE users SET active_status=$1, last_active_at=CASE WHEN $1 THEN NOW() ELSE last_active_at END WHERE id=$2", [active, userId]);
}

module.exports = { logActivity, logActiveStatus };
