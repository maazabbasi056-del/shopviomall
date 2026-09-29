const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const uploadDirectory = path.join(__dirname, "..", "uploads", "products");
const publicImagePattern = /^\/uploads\/products\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif)$/i;
const formats = {
  png: { mime: "image/png", extension: "png", test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  jpeg: { mime: "image/jpeg", extension: "jpg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: "image/webp", extension: "webp", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  gif: { mime: "image/gif", extension: "gif", test: (b) => b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) }
};
const MAX_IMAGE_BYTES = 1024 * 1024;

function parseImageDataUrl(value) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new Error("Images must be PNG, JPEG, WebP, or GIF files.");
  const format = formats[match[1].toLowerCase()];
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !format.test(bytes)) {
    throw new Error("An image is empty, too large, or does not match its file type.");
  }
  return { bytes, extension: format.extension };
}

async function normalizeAndSaveImages(images) {
  if (!Array.isArray(images) || images.length > 5) throw new Error("A product can have up to 5 images.");
  const savedFiles = [];
  const normalized = [];
  try {
    for (const image of images) {
      if (typeof image !== "string" || image.length > 1500000) throw new Error("Invalid image value.");
      if (image.startsWith("data:")) {
        const { bytes, extension } = parseImageDataUrl(image);
        await fs.mkdir(uploadDirectory, { recursive: true });
        const filename = `${crypto.randomUUID()}.${extension}`;
        await fs.writeFile(path.join(uploadDirectory, filename), bytes, { flag: "wx" });
        const url = `/uploads/products/${filename}`;
        savedFiles.push(path.join(uploadDirectory, filename));
        normalized.push(url);
      } else if (/^https:\/\//i.test(image) || publicImagePattern.test(image)) {
        normalized.push(image);
      } else {
        throw new Error("Product images must use HTTPS or a ShopVioMall uploaded image.");
      }
    }
    return { images: normalized, savedFiles };
  } catch (error) {
    await removeFiles(savedFiles);
    throw error;
  }
}

async function removeFiles(files) {
  await Promise.all((files || []).map((file) => fs.rm(file, { force: true }).catch(() => {})));
}

async function removeReplacedLocalImages(oldImages, newImages) {
  const retained = new Set(newImages || []);
  const localFiles = (oldImages || [])
    .filter((url) => publicImagePattern.test(url) && !retained.has(url))
    .map((url) => path.join(uploadDirectory, path.basename(url)));
  await removeFiles(localFiles);
}

module.exports = { normalizeAndSaveImages, removeFiles, removeReplacedLocalImages };
