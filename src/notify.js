async function notifyClass(db, { classId, actorId, type, title, body, page, entityId }) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, class_id, type, title, body, page, entity_id)
       SELECT cm.user_id, $1, $2, $3, $4, $5, $6
       FROM class_members cm
       WHERE cm.class_id = $1 AND cm.user_id <> $7
       ON CONFLICT (user_id, type, entity_id) WHERE entity_id IS NOT NULL DO NOTHING`,
      [classId, type, title, body, page, entityId, actorId]
    );
  } catch (error) {
    console.error("Could not create notifications:", error.message);
  }
}

async function generateDueSoon(db, userId) {
  await db.query(
    `INSERT INTO notifications (user_id, class_id, type, title, body, page, entity_id)
     SELECT $1, t.class_id, 'due_soon', t.title, 'Due within 24 hours', 'tasks', t.id
     FROM tasks t
     JOIN class_members cm ON cm.class_id = t.class_id AND cm.user_id = $1
     WHERE t.due_at IS NOT NULL AND t.due_at > NOW() AND t.due_at <= NOW() + INTERVAL '24 hours'
       AND NOT EXISTS (SELECT 1 FROM task_completions tc WHERE tc.task_id = t.id AND tc.user_id = $1)
     ON CONFLICT (user_id, type, entity_id) WHERE entity_id IS NOT NULL DO NOTHING`,
    [userId]
  );
}

module.exports = { notifyClass, generateDueSoon };
