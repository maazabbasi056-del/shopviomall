const MarketplaceCategory = require("../models/MarketplaceCategory");
const { categories: initialCategories } = require("../config/categories");
let initialCategoriesPromise;

const slugify = value => String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

async function initializeInitialCategories(session) {
  const options = session ? { session } : undefined;
  for (const [name, subcategories] of Object.entries(initialCategories)) {
    const query = MarketplaceCategory.updateOne({ name }, { $setOnInsert: { name, slug: slugify(name), subcategories, seededFromConfig: true } }, { upsert: true, ...options });
    await query;
  }
}

async function ensureInitialCategories(session) {
  if (session) return initializeInitialCategories(session);
  if (!initialCategoriesPromise) {
    initialCategoriesPromise = initializeInitialCategories().catch(error => {
      initialCategoriesPromise = undefined;
      throw error;
    });
  }
  return initialCategoriesPromise;
}

async function listCategories({ includeArchived = false } = {}) {
  await ensureInitialCategories();
  return MarketplaceCategory.find(includeArchived ? {} : { status: "active" }).sort({ name: 1 }).select("name slug subcategories status").lean();
}

async function getCategory(name) {
  await ensureInitialCategories();
  return MarketplaceCategory.findOne({ name, status: "active" }).lean();
}

module.exports = { ensureInitialCategories, listCategories, getCategory, slugify };
