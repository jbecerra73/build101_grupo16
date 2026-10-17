// Headless screenshot of one dashboard page (used for docs/dashboard/control-ui).
//   node apps/dashboard/scripts/shoot.mjs <url> <out.png> [--w 1600] [--h 1000]
//        [--dark] [--wait 2000] [--full] [--keys ArrowRight,ArrowRight] [--click "text=Sandboxes"]
//        [--reduced]
import { chromium } from "playwright";

const [url, out, ...rest] = process.argv.slice(2);
const opt = (k, d) => {
  const i = rest.indexOf(`--${k}`);
  return i < 0 ? d : rest[i + 1];
};
const flag = (k) => rest.includes(`--${k}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: Number(opt("w", 1600)), height: Number(opt("h", 1000)) },
  deviceScaleFactor: Number(opt("scale", 1)),
  colorScheme: flag("dark") ? "dark" : "light",
  reducedMotion: flag("reduced") ? "reduce" : "no-preference",
});
await ctx.addInitScript((dark) => {
  try {
    localStorage.setItem("theme", dark ? "dark" : "light");
  } catch {}
}, flag("dark"));
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && console.error("console:", m.text()));
await page.goto(url, { waitUntil: "load" });
const click = opt("click");
if (click) {
  for (const sel of click.split("|")) {
    await page.locator(sel).first().click();
    await page.waitForTimeout(400);
  }
}
const keys = opt("keys");
const wait = Number(opt("wait", 1500));
if (keys) {
  for (const k of keys.split(",")) {
    await page.keyboard.press(k);
    await page.waitForTimeout(Number(opt("keywait", 900)));
  }
}
await page.waitForTimeout(wait);
await page.screenshot({ path: out, fullPage: flag("full") });
await browser.close();
console.log("saved", out);
