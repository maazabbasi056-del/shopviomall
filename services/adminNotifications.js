const AdminNotification = require("../models/AdminNotification");

async function notifyAdmins({ type, title, message, targetType = "", targetId = null, dedupeKey = "", session }) {
  const options = session ? { session } : undefined;
  if (dedupeKey) {
    const existing = await AdminNotification.findOne({ dedupeKey }).setOptions(options || {});
    if (existing) return existing;
  }
  const item = new AdminNotification({ type, title, message, targetType, targetId, dedupeKey });
  await item.save(options);
  return item;
}

module.exports = { notifyAdmins };
