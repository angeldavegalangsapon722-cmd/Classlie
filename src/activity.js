async function logActivity(db, { classId, userId, action, entityType, entityId = null, summary }) {
  try {
    await db.query(
      `INSERT INTO activity_log (class_id, user_id, action, entity_type, entity_id, summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [classId, userId, action, entityType, entityId, summary]
    );
  } catch (error) {
    console.error("Could not write activity log:", error.message);
  }
}

async function logActiveStatus(db, { userId, active }) {
  await db.query("UPDATE users SET active_status=$1 WHERE id=$2", [active, userId]);
}

module.exports = { logActivity, logActiveStatus };
