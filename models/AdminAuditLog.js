const mongoose = require("mongoose");

const adminAuditLogSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  action: { type: String, required: true, trim: true, maxlength: 100, index: true },
  targetType: { type: String, required: true, trim: true, maxlength: 60, index: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  reason: { type: String, default: "", trim: true, maxlength: 1000 },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, strict: true });

adminAuditLogSchema.index({ createdAt: -1 });
module.exports = mongoose.models.AdminAuditLog || mongoose.model("AdminAuditLog", adminAuditLogSchema);
