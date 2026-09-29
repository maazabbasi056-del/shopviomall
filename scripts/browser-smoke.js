const { chromium } = require("playwright");

const baseUrl = process.env.SHOPVIOMALL_TEST_URL || "http://127.0.0.1:5000";

async function main() {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol) || !["127.0.0.1", "localhost"].includes(base.hostname)) {
    throw new Error("The browser smoke runner only accepts a localhost application URL.");
  }

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--disable-gpu", "--disable-gpu-compositing", "--disable-features=Vulkan,UseSkiaRenderer"]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(base.href, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator("body").getByText("ShopVioMall", { exact: false }).first().waitFor({ state: "visible" });
    if (!(await page.title())) throw new Error("Homepage did not set a document title.");
    console.log("BROWSER_SMOKE_HOME=PASS");

    await page.locator("#login-open").click();
    await page.locator("#auth-modal").waitFor({ state: "visible" });
    if (!(await page.locator('#login-form input[name="identifier"]').isVisible())) throw new Error("Customer login form is not visible.");
    console.log("BROWSER_SMOKE_LOGIN=PASS");

    await page.goto(new URL("/admin", base).href, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.locator("#auth-modal").waitFor({ state: "visible" });
    if (!(await page.locator("#auth-title").innerText()).includes("Admin Login")) throw new Error("Admin login title did not render.");
    if (!(await page.locator('#login-form input[name="identifier"]').isVisible())) throw new Error("Admin username field is not visible.");
    console.log("BROWSER_SMOKE_ADMIN=PASS");

    if (pageErrors.length) throw new Error(`Browser page errors occurred (${pageErrors.length}).`);
    console.log("BROWSER_SMOKE=PASS");
    console.log(`BROWSER_VERSION=${(await browser.version()).replace(/[\r\n]/g, " ").slice(0, 80)}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`BROWSER_SMOKE=FAIL: ${error.message}`);
  process.exitCode = 1;
});
