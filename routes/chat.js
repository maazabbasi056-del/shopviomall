const crypto = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
const ChatConversation = require("../models/ChatConversation");
const ChatMessage = require("../models/ChatMessage");
const { requireAuth, requireDatabase, requireRole, optionalAuth } = require("../middleware/auth");
const { notifyAdmins } = require("../services/adminNotifications");

const router = express.Router();
router.use(requireDatabase);

function guestHash(req) {
  const session = req.get("x-shopviomall-guest") || "";
  if (!/^[0-9a-f-]{36}$/i.test(session)) return "";
  return crypto.createHash("sha256").update(session).digest("hex");
}

function safeConversation(conversation, admin = false) {
  return {
    id: String(conversation._id),
    status: conversation.status,
    lastMessageAt: conversation.lastMessageAt,
    unreadCount: admin ? conversation.unreadForAdmin : conversation.unreadForUser,
    participant: admin && conversation.userId
      ? { name: conversation.userId.name || "ShopVioMall user", role: conversation.userId.role }
      : undefined
  };
}

async function accessibleConversation(req, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const conversation = await ChatConversation.findById(id).select("+guestSessionHash")
    .populate("userId", "name role");
  if (!conversation) return null;
  if (req.user?.role === "admin") return conversation;
  if (req.user && String(conversation.userId?._id || conversation.userId) === String(req.user._id)) return conversation;
  const hash = guestHash(req);
  if (!req.user && hash && conversation.guestSessionHash === hash) return conversation;
  return null;
}

function messageBody(req) {
  const body = req.body?.body;
  if (typeof body !== "string" || !body.trim() || body.trim().length > 4000) return "";
  return body.trim();
}

async function sendMessage(conversation, senderUser, body, senderRole) {
  const message = await ChatMessage.create({
    conversationId: conversation._id,
    senderUserId: senderUser?._id || null,
    senderRole,
    body
  });
  conversation.lastMessageAt = message.createdAt;
  if (senderRole === "admin") conversation.unreadForUser += 1;
  else {
    conversation.unreadForAdmin += 1;
    await notifyAdmins({ type: "important_message", title: "New customer or seller message", message: "A customer or seller sent a support message.", targetType: "chat_conversation", targetId: conversation._id });
  }
  await conversation.save();
  return message;
}

router.post("/conversations/open", optionalAuth, async (req, res, next) => {
  try {
    const hash = req.user ? "" : guestHash(req);
    if (!req.user && !hash) {
      return res.status(400).json({ success: false, message: "A valid temporary chat session is required." });
    }
    const owner = req.user ? { userId: req.user._id, status: "open" } : { guestSessionHash: hash, userId: null, status: "open" };
    let conversation = await ChatConversation.findOne(owner).select("+guestSessionHash");
    if (!conversation) {
      conversation = await ChatConversation.create({
        ...(req.user ? { userId: req.user._id } : { userId: null, guestSessionHash: hash })
      });
    }
    const messages = await ChatMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: -1 }).limit(100).lean();
    if (req.user && conversation.unreadForUser) {
      conversation.unreadForUser = 0;
      await conversation.save();
    }
    return res.json({
      success: true,
      conversation: safeConversation(conversation),
      messages: messages.reverse().map((message) => ({
        id: String(message._id), body: message.body, senderRole: message.senderRole, createdAt: message.createdAt
      }))
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/conversations", optionalAuth, async (req, res, next) => {
  try {
    const filter = req.user
      ? { userId: req.user._id }
      : guestHash(req) ? { guestSessionHash: guestHash(req), userId: null } : null;
    if (!filter) return res.json({ success: true, conversations: [] });
    const conversations = await ChatConversation.find(filter).sort({ lastMessageAt: -1 }).lean();
    return res.json({ success: true, conversations: conversations.map((conversation) => safeConversation(conversation)) });
  } catch (error) {
    return next(error);
  }
});

router.get("/conversations/:conversationId/messages", optionalAuth, async (req, res, next) => {
  try {
    const conversation = await accessibleConversation(req, req.params.conversationId);
    if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
    const messages = await ChatMessage.find({ conversationId: conversation._id })
      .sort({ createdAt: -1 }).limit(100).populate("senderUserId", "name").lean();
    if (req.user?.role === "admin") conversation.unreadForAdmin = 0;
    else conversation.unreadForUser = 0;
    await conversation.save();
    return res.json({ success: true, conversation: safeConversation(conversation, req.user?.role === "admin"), messages: messages.reverse().map((message) => ({
      id: String(message._id), body: message.body, senderRole: message.senderRole,
      senderName: message.senderRole === "admin" ? "ShopVioMall support" : message.senderRole === "guest" ? "Guest" : message.senderUserId?.name || "ShopVioMall user",
      createdAt: message.createdAt
    })) });
  } catch (error) {
    return next(error);
  }
});

router.post("/conversations/:conversationId/messages", optionalAuth, async (req, res, next) => {
  try {
    const body = messageBody(req);
    if (!body) return res.status(400).json({ success: false, message: "Message must contain 1 to 4000 characters." });
    const conversation = await accessibleConversation(req, req.params.conversationId);
    if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
    if (conversation.status !== "open") return res.status(409).json({ success: false, message: "This conversation is closed." });
    const role = req.user ? req.user.role : "guest";
    const message = await sendMessage(conversation, req.user, body, role);
    return res.status(201).json({
      success: true,
      message: { id: String(message._id), body: message.body, senderRole: role, createdAt: message.createdAt },
      unreadCount: conversation.unreadForUser
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/admin/conversations", requireAuth, requireRole("admin"), async (_req, res, next) => {
  try {
    const conversations = await ChatConversation.find().populate("userId", "name email role")
      .sort({ lastMessageAt: -1 }).limit(100).lean();
    const conversationIds = conversations.map((conversation) => conversation._id);
    const latestMessages = conversationIds.length ? await ChatMessage.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$conversationId", body: { $first: "$body" }, senderRole: { $first: "$senderRole" } } }
    ]) : [];
    const lastByConversation = new Map(latestMessages.map((message) => [String(message._id), message]));
    return res.json({ success: true, conversations: conversations.map((conversation) => ({
      ...safeConversation(conversation, true),
      participant: conversation.userId ? { id: String(conversation.userId._id), name: conversation.userId.name || "ShopVioMall user", email: conversation.userId.email || "", role: conversation.userId.role } : { id: "", name: "Guest conversation", role: "guest" },
      lastMessage: lastByConversation.has(String(conversation._id)) ? { body: lastByConversation.get(String(conversation._id)).body.slice(0, 240), senderRole: lastByConversation.get(String(conversation._id)).senderRole } : null
    })) });
  } catch (error) {
    return next(error);
  }
});

router.post("/admin/conversations/:conversationId/messages", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const body = messageBody(req);
    if (!body) return res.status(400).json({ success: false, message: "Message must contain 1 to 4000 characters." });
    const conversation = await ChatConversation.findById(req.params.conversationId);
    if (!conversation) return res.status(404).json({ success: false, message: "Conversation not found." });
    if (conversation.status !== "open") return res.status(409).json({ success: false, message: "This conversation is closed." });
    const message = await sendMessage(conversation, req.user, body, "admin");
    return res.status(201).json({
      success: true,
      message: { id: String(message._id), body: message.body, senderRole: "admin", createdAt: message.createdAt },
      unreadCount: conversation.unreadForUser
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
