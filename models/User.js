const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: function () { return this.role !== "admin"; },
      unique: true,
      lowercase: true,
      trim: true
    },
    username: {
      type: String,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 40
    },
    password: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["customer", "vendor", "admin"],
      default: "customer"
    },
    walletAddress: { type: String, default: "" },
    shopName: { type: String, default: "", trim: true },
    shopBio: { type: String, default: "", trim: true },
    shopSlug: { type: String, default: "", lowercase: true, trim: true, maxlength: 80 },
    shopImageUrl: { type: String, default: "", trim: true, maxlength: 2048 },
    emailVerified: { type: Boolean, default: false },
    kycStatus: { type: String, enum: ["not_submitted", "pending", "approved", "rejected"], default: "not_submitted" },
    accountStatus: { type: String, enum: ["pending", "approved", "suspended"], default: "pending" },
    customerStatus: { type: String, enum: ["active", "suspended"], default: "active" },
    transactionPassword: { type: String, default: "", select: false },
    idProofUrl: { type: String, default: "" }
  },
  { timestamps: true }
);

userSchema.pre("save", async function () {
  if (this.isModified("password") && this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }

  if (this.isModified("transactionPassword") && this.transactionPassword) {
    this.transactionPassword = await bcrypt.hash(this.transactionPassword, 12);
  }
});

userSchema.index({ shopSlug: 1 }, { unique: true, partialFilterExpression: { shopSlug: { $type: "string", $gt: "" } } });
userSchema.index({ username: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
