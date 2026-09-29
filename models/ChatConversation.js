const mongoose = require("mongoose");

const chatConversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  guestSessionHash: { type: String, default: "", select: false, index: true },
  status: { type: String, enum: ["open", "closed"], default: "open", index: true },
  unreadForAdmin: { type: Number, default: 0, min: 0 },
  unreadForUser: { type: Number, default: 0, min: 0 },
  lastMessageAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

chatConversationSchema.index({ userId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.models.ChatConversation || mongoose.model("ChatConversation", chatConversationSchema);
