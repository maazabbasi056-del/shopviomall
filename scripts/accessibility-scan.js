const { chromium } = require("playwright");
const axeSource = require("axe-core").source;
const base = process.env.SHOPVIOMALL_TEST_URL || "http://127.0.0.1:5000";

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu", "--disable-gpu-compositing", "--disable-features=Vulkan,UseSkiaRenderer"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    for (const route of ["/", "/admin"]) {
      await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
      if (route === "/") {
        await page.locator("#login-open").click();
        await page.addScriptTag({ content: axeSource });
        const report = await page.evaluate(async () => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
        for (const violation of report.violations) for (const node of violation.nodes) {
          console.log(`${violation.id} [${violation.impact}] ${node.target.join(", ")} :: ${(node.failureSummary || "").replace(/\s+/g, " ").slice(0, 500)}`);
        }
        await page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded" });
      }
      await page.addScriptTag({ content: axeSource });
      const report = await page.evaluate(async () => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
      for (const violation of report.violations) for (const node of violation.nodes) {
        console.log(`${route} ${violation.id} [${violation.impact}] ${node.target.join(", ")} :: ${(node.failureSummary || "").replace(/\s+/g, " ").slice(0, 500)}`);
      }
    }
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(`ACCESSIBILITY_SCAN=FAIL (${error.name})`); process.exitCode = 1; });
