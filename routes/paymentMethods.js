const express = require("express");
const PaymentMethod = require("../models/PaymentMethod");
const { requireDatabase } = require("../middleware/auth");
const router = express.Router();
router.get("/", requireDatabase, async (_req, res, next) => {
  try { const methods = await PaymentMethod.find({ enabled: true }).select("asset symbol network receivingAddress instructions minimumDeposit").sort({ asset: 1, network: 1 }).lean(); res.json({ success: true, methods }); }
  catch (error) { next(error); }
});
module.exports = router;
