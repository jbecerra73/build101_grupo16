// Captures the real production storefront for the dashboard fixtures, once per
// persona look, into scripts/shots/<persona>/<page>.png (gen-fixtures.mjs copies
// them into the run folders). Needs Playwright's Chromium:
//   npx playwright install chromium   (once)
//   node apps/dashboard/scripts/capture-screenshots.mjs
// Looks: typical 1280×800; rosa 1280×800 seen through her perception filter
// (downscale 0.6 + blur 1.5px, from shared/personas.ts); kai 375×812 mobile.
// Stored as palette PNGs about 640px wide to keep the repo small.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const SITE = process.env.CAPTURE_SITE ?? "https://swarm-ecommerce.netlify.app";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "shots");
const WIDTH = 640;
const PRODUCT = "/shop/product/1/T-shirt-with-Tape-Details";

const LOOKS = {
  typical: { context: { viewport: { width: 1280, height: 800 } } },
  rosa: { context: { viewport: { width: 1280, height: 800 } }, perception: { downscale: 0.6, blur: 1.5 } },
  kai: { context: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
};

async function save(page, look, name) {
  const { perception } = LOOKS[look];
  let img = sharp(await page.screenshot());
  if (perception) {
    const { width } = await img.metadata();
    const seen = await img.resize(Math.round(width * perception.downscale)).blur(perception.blur).toBuffer();
    img = sharp(seen);
  }
  const file = join(OUT, look, `${name}.png`);
  const info = await img.resize(WIDTH).png({ palette: true, quality: 80, compressionLevel: 9, effort: 10 }).toFile(file);
  console.log(`${look}/${name}.png ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

async function goto(page, path) {
  await page.goto(SITE + path, { waitUntil: "load" });
  // Mobile pages keep a connection open now and then: networkidle is best effort.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  // The "Powered by Netlify" badge covers buttons on mobile; keep it visible but click-through.
  await page.addStyleTag({ content: "#nl-badge-frame{pointer-events:none!important}" }).catch(() => {});
}

async function capture(browser, look) {
  mkdirSync(join(OUT, look), { recursive: true });
  const ctx = await browser.newContext(LOOKS[look].context);
  const page = await ctx.newPage();

  await goto(page, "/");
  await save(page, look, "home");
  await goto(page, "/shop");
  await save(page, look, "shop");
  await goto(page, PRODUCT);
  await save(page, look, "product");
  await page.getByRole("button", { name: "Medium", exact: true }).click();
  await page.getByRole("button", { name: "Add to Cart" }).click();
  await page.waitForTimeout(500);

  await goto(page, "/cart");
  await save(page, look, "cart");
  await goto(page, "/checkout");
  await save(page, look, "checkout");
  // /checkout/account (the T2 sign-up wall) is not deployed on production:
  // the closest page is the checkout it guards.
  await save(page, look, "account");

  const fields = { email: "ana@example.com", fullName: "Ana Pérez", address: "123 Main St", city: "Springfield", postalCode: "12345" };
  for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(value);
  await page.getByText("Continue to Payment", { exact: false }).first().click();
  await page.waitForTimeout(800);
  if (!page.url().includes("step=payment")) await goto(page, "/checkout?step=payment");
  await page.evaluate(() => window.scrollTo(0, 0));
  await save(page, look, "payment");

  const card = { cardNumber: "4242 4242 4242 4242", cardName: "Ana Pérez", expiry: "12/30", cvc: "123" };
  for (const [id, value] of Object.entries(card)) {
    const input = page.locator(`#${id}`);
    if (await input.count()) await input.fill(value);
  }
  const pay = page.getByRole("button", { name: /^Pay/ });
  if (await pay.count()) {
    await pay.first().click();
    await page.waitForURL(/checkout\/success/, { timeout: 10_000 }).catch(() => {});
  }
  if (!page.url().includes("/checkout/success")) await goto(page, "/checkout/success");
  await page.waitForTimeout(600);
  await save(page, look, "success");
  console.log(`${look}: success page ${(await page.getByText("Payment confirmed").count()) ? "shows the confirmation" : "has no order"}`);
  await ctx.close();
}

const browser = await chromium.launch();
try {
  for (const look of Object.keys(LOOKS)) await capture(browser, look);
} finally {
  await browser.close();
}
