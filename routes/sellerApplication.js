const express = require("express");
const User = require("../models/User");
const SellerApplication = require("../models/SellerApplication");
const SellerKycDocument = require("../models/SellerKycDocument");
const { requireDatabase, requireAuth, requireRole } = require("../middleware/auth");
const { notifyAdmins } = require("../services/adminNotifications");

const router = express.Router();
router.use(requireDatabase, requireAuth, requireRole("customer"));
const docKinds = ["id_front", "id_back", "selfie"];

router.get("/", async (req, res, next) => {
  try {
    const [application, documents] = await Promise.all([
      SellerApplication.findOne({ sellerId: req.user._id }).select("shopName shopSlug description documentType status submittedAt reviewedAt sellerMessage updatedAt").lean(),
      SellerKycDocument.find({ sellerId: req.user._id }).select("kind filename reviewStatus reviewNote createdAt").lean()
    ]);
    res.json({ success: true, application, shop: { shopName: req.user.shopName || "", shopSlug: req.user.shopSlug || "", description: req.user.shopBio || "" }, documents });
  } catch (error) { next(error); }
});

router.put("/shop", async (req, res, next) => {
  const shopName = String(req.body?.shopName || "").trim();
  const shopSlug = String(req.body?.shopSlug || "").trim().toLowerCase();
  const description = String(req.body?.description || "").trim();
  if (!shopName || shopName.length > 120 || !description || description.length > 1000 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 80) return res.status(400).json({ success: false, message: "Enter a shop name, description, and URL using lowercase letters, numbers, or hyphens." });
  try {
    if (await User.exists({ shopSlug, _id: { $ne: req.user._id } })) return res.status(409).json({ success: false, message: "That shop URL is already in use." });
    const application = await SellerApplication.findOne({ sellerId: req.user._id });
    if (application?.status === "approved") return res.status(409).json({ success: false, message: "Your seller application is already approved." });
    req.user.shopName = shopName; req.user.shopSlug = shopSlug; req.user.shopBio = description; await req.user.save();
    res.json({ success: true, shop: { shopName, shopSlug, description }, previewUrl: `/shop/${encodeURIComponent(shopSlug)}` });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ success: false, message: "That shop URL is already in use." }); next(error); }
});

router.put("/documents/:kind", async (req, res, next) => {
  const { filename, mimeType, data } = req.body || {};
  if (!docKinds.includes(req.params.kind) || typeof filename !== "string" || filename.length > 120 || !["image/jpeg", "image/png", "application/pdf"].includes(mimeType) || typeof data !== "string") return res.status(400).json({ success: false, message: "Provide a supported identity document." });
  const match = /^data:(image\/(?:jpeg|png)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match || match[1] !== mimeType) return res.status(400).json({ success: false, message: "The selected file type is invalid." });
  try {
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 3 * 1024 * 1024) return res.status(400).json({ success: false, message: "KYC files must not exceed 3 MB." });
    const valid = mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 : mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.subarray(0,5).toString() === "%PDF-";
    if (!valid) return res.status(400).json({ success: false, message: "The file contents do not match its type." });
    const doc = await SellerKycDocument.findOneAndUpdate({ sellerId: req.user._id, kind: req.params.kind }, { $set: { filename: filename.replace(/[\\/]/g, "_").slice(0, 120), mimeType, data: bytes, reviewStatus: "pending", reviewNote: "" } }, { new: true, upsert: true, runValidators: true }).select("kind filename mimeType reviewStatus createdAt");
    req.user.kycStatus = "pending"; await req.user.save();
    res.json({ success: true, document: doc });
  } catch (error) { next(error); }
});

router.post("/submit", async (req, res, next) => {
  const documentType = req.body?.documentType;
  const documentNumber = typeof req.body?.documentNumber === "string" ? req.body.documentNumber.trim() : "";
  const termsAccepted = req.body?.termsAccepted === true;
  if (!["national_id", "passport", "driving_license"].includes(documentType) || !documentNumber || documentNumber.length > 100 || !termsAccepted) return res.status(400).json({ success: false, message: "Select a document type, enter the document number, and accept the seller terms." });
  try {
    let application = await SellerApplication.findOne({ sellerId: req.user._id }).select("+documentNumber");
    if (!req.user.shopName || !req.user.shopSlug || !req.user.shopBio) return res.status(409).json({ success: false, message: "Save Shop Details before submitting identity verification." });
    if (application?.status === "approved") return res.status(409).json({ success: false, message: "Your seller application is already approved." });
    const required = documentType === "passport" ? ["id_front", "selfie"] : docKinds;
    const docs = await SellerKycDocument.find({ sellerId: req.user._id, kind: { $in: required }, reviewStatus: { $ne: "rejected" } }).select("kind").lean();
    if (!required.every((kind) => docs.some((doc) => doc.kind === kind))) return res.status(400).json({ success: false, message: "Upload each required verification image before submitting." });
    if (!application) application = new SellerApplication({ sellerId: req.user._id, shopName: req.user.shopName, shopSlug: req.user.shopSlug, description: req.user.shopBio });
    application.shopName = req.user.shopName; application.shopSlug = req.user.shopSlug; application.description = req.user.shopBio;
    application.documentType = documentType; application.documentNumber = documentNumber; application.termsAcceptedAt = new Date(); application.status = "pending"; application.submittedAt = new Date(); application.reviewedAt = null; application.reviewedBy = null; application.sellerMessage = "";
    await application.save(); req.user.kycStatus = "pending"; await req.user.save();
    await notifyAdmins({ type: "seller_application", title: "New seller application", message: `${application.shopName} submitted a seller verification application.`, targetType: "seller_application", targetId: application._id, dedupeKey: `seller-application:${application._id}:${application.submittedAt.getTime()}` });
    res.status(201).json({ success: true, application: { shopName: application.shopName, shopSlug: application.shopSlug, status: application.status, submittedAt: application.submittedAt } });
  } catch (error) { next(error); }
});

module.exports = router;
