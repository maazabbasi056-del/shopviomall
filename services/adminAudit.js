const AdminAuditLog = require("../models/AdminAuditLog");

async function recordAdminAction({ adminId, action, targetType, targetId = null, reason = "", details = {}, session }) {
  const entry = new AdminAuditLog({ adminId, action, targetType, targetId, reason, details });
  await entry.save(session ? { session } : undefined);
  return entry;
}

module.exports = { recordAdminAction };
