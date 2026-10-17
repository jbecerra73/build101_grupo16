import type { Page } from "playwright";
import type { Persona } from "../shared";

type Perception = Persona["perception"];

/** An interactive element the agent can target, tagged in the DOM with data-fs-id. */
export type PageElement = {
  id: string;
  role: string;
  name: string;
  /** Stable-ish CSS selector for the trace (the agent targets `id`). */
  selector: string;
  /** id or name attribute of form fields, recorded on `type` actions in the trace. */
  field?: string;
  value?: string;
  rect: { x: number; y: number; width: number; height: number };
};

export type Observation = {
  url: string;
  title: string;
  /** What the model sees (with element labels drawn on it). */
  screenshot: Buffer;
  /** Clean screenshot for the run folder. */
  cleanScreenshot: Buffer;
  elements: PageElement[];
  headings: string[];
  scroll: { y: number; maxY: number };
};

export const ID_ATTR = "data-fs-id";
/** Set on text the persona cannot perceive; it is blanked in the model's screenshot. */
const HIDE_ATTR = "data-fs-hide";

const INTERACTIVE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=option]",
  "[role=combobox]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[onclick]",
].join(",");

/** Tag visible in-viewport interactive elements and read them back. Text below the persona's
 * contrast or font-size threshold is tagged hidden, and elements whose text is all hidden are dropped. */
async function collect(page: Page, perception: Perception) {
  // tsx/esbuild wrap named functions in __name(); give the page a no-op so evaluated code runs.
  await page.evaluate("globalThis.__name ??= (f) => f");
  return page.evaluate(
    ({ sel, attr, hideAttr, minContrast, minFontPx }) => {
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      document.querySelectorAll(`[${hideAttr}]`).forEach((el) => el.removeAttribute(hideAttr));
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

      // Any CSS color (including oklch) to RGBA via a 1px canvas.
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
      };
      const over = (top: number[], bottom: number[]) => top.slice(0, 3).map((c, i) => c * top[3] + bottom[i] * (1 - top[3]));
      /** Composites ancestor backgrounds over white (background images are ignored). */
      const backgroundOf = (el: Element) => {
        const layers: number[][] = [];
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor);
          if (c[3] > 0) layers.push(c);
          if (c[3] >= 1) break;
        }
        return layers.reduceRight((acc, l) => over(l, acc), [255, 255, 255]);
      };
      const luminance = (rgb: number[]) => {
        const [r, g, b] = rgb.map((c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (el: Element) => {
        const bg = backgroundOf(el);
        const fg = over(rgba(getComputedStyle(el).color), bg);
        const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      };
      const textParents = (root: Element) => {
        const parents = new Set<Element>();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode())
          if (t.textContent?.trim() && t.parentElement) parents.add(t.parentElement);
        return parents;
      };
      if (minContrast || minFontPx)
        for (const p of textParents(document.body)) {
          if (p.closest("script,style,noscript")) continue;
          const r = p.getBoundingClientRect();
          if (r.bottom < 0 || r.top > vh || r.width < 1) continue;
          const small = minFontPx && parseFloat(getComputedStyle(p).fontSize) < minFontPx;
          if (small || (minContrast && contrast(p) < minContrast)) p.setAttribute(hideAttr, "");
        }
      const unreadable = (el: Element) => {
        const parents = [...textParents(el)];
        return parents.length > 0 && parents.every((p) => p.hasAttribute(hideAttr));
      };
      const labelFor = (el: Element) => {
        const id = el.getAttribute("id");
        const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest("label");
        return clean(l?.textContent);
      };
      const selectorFor = (el: Element) => {
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        if (id && !/^radix-|^:r/.test(id)) return `#${CSS.escape(id)}`;
        for (const a of ["data-testid", "name", "aria-label"]) {
          const v = el.getAttribute(a);
          if (v) return `${tag}[${a}=${JSON.stringify(v)}]`;
        }
        const href = el.getAttribute("href");
        if (tag === "a" && href) return `a[href=${JSON.stringify(href)}]`;
        const text = clean((el as HTMLElement).innerText).slice(0, 40);
        return text ? `${tag}:has-text(${JSON.stringify(text)})` : tag;
      };

      const out: {
        id: string; role: string; name: string; selector: string; field?: string; value?: string;
        rect: { x: number; y: number; width: number; height: number };
      }[] = [];
      let n = 0;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
        if ((el as HTMLElement).closest("[aria-hidden=true]")) continue;
        // Skip elements nested in another interactive element (e.g. icon inside a button).
        if (el.parentElement?.closest(sel)) continue;
        if (unreadable(el)) continue;

        const tag = el.tagName.toLowerCase();
        const input = el as HTMLInputElement;
        const isField = tag === "input" || tag === "textarea" || tag === "select";
        const role = el.getAttribute("role") ?? (isField ? `${tag}${input.type ? `[${input.type}]` : ""}` : tag === "a" ? "link" : tag);
        const name =
          clean(el.getAttribute("aria-label")) ||
          (isField ? labelFor(el) || clean(input.placeholder) : clean((el as HTMLElement).innerText)) ||
          clean(el.getAttribute("title")) ||
          clean(el.querySelector("img")?.getAttribute("alt")) ||
          (cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? `unlabeled, color ${cs.backgroundColor}` : "");
        const id = `e${++n}`;
        el.setAttribute(attr, id);
        out.push({
          id,
          role,
          name,
          selector: selectorFor(el),
          field: isField ? (el.getAttribute("id") || el.getAttribute("name") || undefined) : undefined,
          value: isField && input.type !== "password" ? clean(input.value) || undefined : undefined,
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        });
      }
      const headings = [...document.querySelectorAll("h1,h2,h3,[role=dialog] [role=heading]")]
        .filter((h) => {
          const r = h.getBoundingClientRect();
          return r.height > 0 && r.bottom > 0 && r.top < vh;
        })
        .map((h) => clean((h as HTMLElement).innerText))
        .filter(Boolean);
      const maxY = Math.max(0, document.documentElement.scrollHeight - vh);
      return { elements: out, headings, scroll: { y: Math.round(window.scrollY), maxY } };
    },
    { sel: INTERACTIVE, attr: ID_ATTR, hideAttr: HIDE_ATTR, minContrast: perception.minContrast, minFontPx: perception.minFontPx },
  );
}

/** Builds what the model sees: the persona's blur and downscale applied to the page,
 * then element ids drawn on top (set-of-marks), kept sharp so the model can name targets. */
async function compose(page: Page, png: Buffer, elements: PageElement[], perception: Perception): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ b64, els, blur, scale }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const img = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d")!;
      if (blur) ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.filter = "none";
      ctx.font = "bold 13px monospace";
      ctx.textBaseline = "top";
      for (const e of els) {
        const [x, y, w, h] = [e.rect.x * scale, e.rect.y * scale, e.rect.width * scale, e.rect.height * scale];
        ctx.strokeStyle = "#e11d48";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
        const tw = ctx.measureText(e.id).width + 6;
        const [tx, ty] = [Math.max(0, x), Math.max(0, y - 16)];
        ctx.fillStyle = "#e11d48";
        ctx.fillRect(tx, ty, tw, 15);
        ctx.fillStyle = "#fff";
        ctx.fillText(e.id, tx + 3, ty + 1);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    },
    { b64: png.toString("base64"), els: elements, blur: perception.blur ?? 0, scale: perception.downscale ?? 1 },
  );
  return Buffer.from(b64, "base64");
}

export async function observe(page: Page, perception: Perception = { mode: "screenshot+a11y" }): Promise<Observation> {
  const { elements, headings, scroll } = await collect(page, perception);
  const cleanScreenshot = await page.screenshot({ type: "png", scale: "css" });
  let seen = cleanScreenshot;
  if (await page.locator(`[${HIDE_ATTR}]`).count()) {
    const style = await page.addStyleTag({ content: `[${HIDE_ATTR}]{color:transparent!important;text-shadow:none!important}` });
    seen = await page.screenshot({ type: "png", scale: "css" });
    await style.evaluate((el) => (el as Element).remove()).catch(() => {});
  }
  const screenshot = await compose(page, seen, elements, perception);
  return { url: page.url(), title: await page.title(), screenshot, cleanScreenshot, elements, headings, scroll };
}

/** Trimmed accessibility listing the model reads alongside the screenshot. A screenshot-only
 * persona gets no DOM text: just the address bar, scroll position and the ids drawn on screen. */
export function describe(obs: Observation, mode: Perception["mode"] = "screenshot+a11y"): string {
  if (mode === "screenshot")
    return [
      `URL: ${new URL(obs.url).pathname}${new URL(obs.url).search}`,
      `Scroll: ${obs.scroll.y}/${obs.scroll.maxY}px${obs.scroll.y < obs.scroll.maxY ? " (more below)" : ""}`,
      `Element ids on screen: ${obs.elements.map((e) => e.id).join(", ") || "none"}`,
    ].join("\n");
  const lines = [
    `URL: ${new URL(obs.url).pathname}${new URL(obs.url).search}`,
    `Title: ${obs.title}`,
    obs.headings.length ? `Headings: ${obs.headings.join(" | ")}` : "",
    `Scroll: ${obs.scroll.y}/${obs.scroll.maxY}px${obs.scroll.y < obs.scroll.maxY ? " (more below)" : ""}`,
    "Interactive elements in view:",
    ...obs.elements.map(
      (e) => `  [${e.id}] ${e.role} "${e.name}"${e.value ? ` value="${e.value}"` : ""}`,
    ),
  ];
  return lines.filter(Boolean).join("\n");
}
