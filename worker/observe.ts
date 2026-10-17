import type { Page } from "playwright";

/** An interactive element the agent can target, tagged in the DOM with data-fs-id. */
export type PageElement = {
  id: string;
  role: string;
  name: string;
  /** Stable-ish CSS selector for the event log (the agent targets `id`). */
  selector: string;
  /** id or name attribute of form fields, used as Event.action.field. */
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

/** Tag visible in-viewport interactive elements and read them back. */
async function collect(page: Page) {
  // tsx/esbuild wrap named functions in __name(); give the page a no-op so evaluated code runs.
  await page.evaluate("globalThis.__name ??= (f) => f");
  return page.evaluate(
    ({ sel, attr }) => {
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
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
    { sel: INTERACTIVE, attr: ID_ATTR },
  );
}

/** Draw element ids next to each element (set-of-marks) for the model's screenshot. */
async function withMarks<T>(page: Page, elements: PageElement[], fn: () => Promise<T>): Promise<T> {
  await page.evaluate((els) => {
    const layer = document.createElement("div");
    layer.id = "__fs_marks";
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    for (const e of els) {
      const tag = document.createElement("div");
      tag.textContent = e.id;
      tag.style.cssText =
        `position:absolute;left:${Math.max(0, e.rect.x)}px;top:${Math.max(0, e.rect.y - 14)}px;` +
        "font:bold 11px/13px monospace;background:#e11d48;color:#fff;padding:0 3px;border-radius:3px";
      const box = document.createElement("div");
      box.style.cssText =
        `position:absolute;left:${e.rect.x}px;top:${e.rect.y}px;width:${e.rect.width}px;height:${e.rect.height}px;` +
        "outline:1.5px solid #e11d48";
      layer.append(box, tag);
    }
    document.body.append(layer);
  }, elements);
  try {
    return await fn();
  } finally {
    await page.evaluate(() => document.getElementById("__fs_marks")?.remove()).catch(() => {});
  }
}

export async function observe(page: Page): Promise<Observation> {
  const { elements, headings, scroll } = await collect(page);
  const cleanScreenshot = await page.screenshot({ type: "png" });
  const screenshot = await withMarks(page, elements, () => page.screenshot({ type: "png" }));
  return { url: page.url(), title: await page.title(), screenshot, cleanScreenshot, elements, headings, scroll };
}

/** Trimmed accessibility listing the model reads alongside the screenshot. */
export function describe(obs: Observation): string {
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
