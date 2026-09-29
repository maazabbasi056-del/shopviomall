const { getCategory } = require("./categoryCatalog");
const { normalizeAndSaveImages, removeFiles, removeReplacedLocalImages } = require("./productImages");

const allowedFields = new Set([
  "title", "description", "detailedDescription", "price", "originalPrice", "baseCost",
  "category", "subcategory", "images", "stock", "sku", "status", "brand", "condition", "specifications"
]);

async function normalizeProductInput(body, { partial = false, previousProduct = null } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A product object is required." };
  }
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return { error: "The request includes unsupported product fields." };
  }

  const required = ["title", "description", "category", "price", "stock"];
  if (!partial && required.some((field) => body[field] === undefined)) {
    return { error: "Title, description, category, price, and stock are required." };
  }

  const fields = {};
  for (const field of ["title", "description", "detailedDescription", "category", "subcategory", "sku", "status"]) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string") return { error: `${field} must be text.` };
      fields[field] = body[field].trim();
    }
  }

  if (fields.title !== undefined && (fields.title.length < 2 || fields.title.length > 160)) {
    return { error: "Title must be between 2 and 160 characters." };
  }
  if (fields.description !== undefined && (!fields.description || fields.description.length > 5000)) {
    return { error: "Description is required and must be at most 5000 characters." };
  }
  if (fields.detailedDescription?.length > 15000) return { error: "Detailed description is too long." };
  if (fields.sku?.length > 80) return { error: "SKU must be at most 80 characters." };
  if (fields.category !== undefined && !await getCategory(fields.category)) {
    return { error: "Choose a category from the ShopVioMall category list." };
  }
  if (fields.subcategory !== undefined && fields.subcategory) {
    const category = fields.category || previousProduct?.category || body.category;
    const categoryRecord = category ? await getCategory(category) : null;
    if (!categoryRecord || !categoryRecord.subcategories.includes(fields.subcategory)) {
      return { error: "Choose a subcategory belonging to the selected category." };
    }
  }

  for (const field of ["price", "originalPrice", "baseCost"]) {
    if (body[field] !== undefined) {
      if (body[field] === "" && field === "originalPrice") {
        fields.originalPrice = undefined;
        continue;
      }
      if (body[field] === "" || body[field] === null) return { error: `${field} must be a non-negative number.` };
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < 0) return { error: `${field} must be a non-negative number.` };
      fields[field] = value;
    }
  }
  if (body.brand !== undefined) {
    if (typeof body.brand !== "string" || body.brand.trim().length > 100) return { error: "Brand must be text of at most 100 characters." };
    fields.brand = body.brand.trim();
  }
  if (body.condition !== undefined) {
    if (!['new', 'used', 'refurbished'].includes(body.condition)) return { error: "Choose new, used, or refurbished condition." };
    fields.condition = body.condition;
  }
  if (body.specifications !== undefined) {
    if (!Array.isArray(body.specifications) || body.specifications.length > 30 || body.specifications.some(item => !item || typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > 80 || typeof item.value !== "string" || item.value.trim().length > 500)) return { error: "Provide up to 30 valid specification name/value pairs." };
    fields.specifications = body.specifications.map(item => ({ name: item.name.trim(), value: item.value.trim() }));
  }
  const effectivePrice = fields.price ?? previousProduct?.price;
  if (fields.originalPrice !== undefined && effectivePrice !== undefined && fields.originalPrice < effectivePrice) {
    return { error: "Original price must be equal to or greater than the current price." };
  }
  if (body.stock !== undefined) {
    if (body.stock === "" || body.stock === null) return { error: "Stock must be a non-negative whole number." };
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0) return { error: "Stock must be a non-negative whole number." };
    fields.stock = stock;
  }
  if (fields.status !== undefined && !["draft", "active", "archived"].includes(fields.status)) {
    return { error: "Status must be draft, active, or archived." };
  }
  if (fields.status === undefined && !partial) fields.status = "draft";

  let savedFiles = [];
  if (body.images !== undefined) {
    const result = await normalizeAndSaveImages(body.images);
    fields.images = result.images;
    savedFiles = result.savedFiles;
  } else if (!partial) {
    fields.images = [];
  }
  return { fields, savedFiles };
}

async function applyProductUpdate(product, fields, savedFiles) {
  const oldImages = product.images || [];
  try {
    product.set(fields);
    await product.save();
    await removeReplacedLocalImages(oldImages, product.images);
    return product;
  } catch (error) {
    await removeFiles(savedFiles);
    throw error;
  }
}

module.exports = { normalizeProductInput, applyProductUpdate, removeFiles };
