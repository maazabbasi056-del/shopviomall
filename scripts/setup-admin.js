require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");

const ADMIN_USERNAME = "svm_owner";

function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Run this setup from an interactive local terminal."));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      try { input.setRawMode(false); } catch {}
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("Setup cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured in the local environment.");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  await User.init();

  let password = "";
  let confirmation = "";
  try {
    password = await readHidden("Set password for svm_owner (12–72 UTF-8 bytes, input hidden): ");
    confirmation = await readHidden("Confirm password (input hidden): ");
    if (Buffer.byteLength(password, "utf8") < 12 || Buffer.byteLength(password, "utf8") > 72) {
      throw new Error("Password must be between 12 and 72 UTF-8 bytes.");
    }
    if (password !== confirmation) throw new Error("Passwords do not match.");

    let admin = await User.findOne({ username: ADMIN_USERNAME }).select("+password");
    if (admin && admin.role !== "admin") {
      throw new Error("The requested username is already assigned to a non-admin account.");
    }
    if (!admin) {
      admin = new User({
        name: "ShopVioMall Owner",
        username: ADMIN_USERNAME,
        role: "admin",
        password
      });
    } else {
      admin.username = ADMIN_USERNAME;
      admin.role = "admin";
      admin.password = password;
    }

    await admin.save();
    console.log("svm_owner admin account is ready; its password is stored as a bcrypt hash.");
  } finally {
    password = "";
    confirmation = "";
  }
}

main()
  .catch(() => {
    console.error("Admin setup failed. Check the local database connection, username availability, and password confirmation, then retry.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
