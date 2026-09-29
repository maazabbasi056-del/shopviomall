const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ChatConversation",
    required: true,
    index: true
  },
  senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  senderRole: { type: String, enum: ["customer", "vendor", "admin", "guest"], required: true },
  body: { type: String, required: true, trim: true, maxlength: 4000 }
}, { timestamps: true });

chatMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.models.ChatMessage || mongoose.model("ChatMessage", chatMessageSchema);
