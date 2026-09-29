const SellerNotification = require("../models/SellerNotification");

async function notifySeller({ recipientId, recipientRole = "vendor", type, title, message, targetType = "", targetId = null, dedupeKey, session }) {
  let query = SellerNotification.findOne({ dedupeKey });
  if (session) query = query.session(session);
  if (await query) return;
  try { await SellerNotification.create([{ recipientId, recipientRole, type, title, message, targetType, targetId, dedupeKey }], session ? { session } : undefined); }
  catch (error) { if (error.code !== 11000) throw error; }
}

module.exports = { notifySeller };
