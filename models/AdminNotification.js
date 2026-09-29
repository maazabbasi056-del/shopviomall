const mongoose = require("mongoose");

const adminNotificationSchema = new mongoose.Schema({
  type: { type: String, required: true, trim: true, maxlength: 80, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  message: { type: String, required: true, trim: true, maxlength: 600 },
  targetType: { type: String, default: "", trim: true, maxlength: 60 },
  targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
  readAt: { type: Date, default: null, index: true },
  dedupeKey: { type: String, default: "", select: false }
}, { timestamps: true });

adminNotificationSchema.index({ createdAt: -1 });
adminNotificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string", $gt: "" } } });
module.exports = mongoose.models.AdminNotification || mongoose.model("AdminNotification", adminNotificationSchema);
