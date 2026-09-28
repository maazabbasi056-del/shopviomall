const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
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

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
