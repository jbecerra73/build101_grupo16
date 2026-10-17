// PostHog's serialized element chain, e.g.
//   div.flex.items-center.rounded-full:nth-child="1"nth-of-type="1"text="Size";div.group.relative
// (clicked element first, ancestors after `;`), turned into something a person
// and the coding agent can read.

export type ChainElement = { tag: string; classes: string[]; attrs: Record<string, string>; text?: string };

const ATTR_START = /:(?=(?:attr__[\w-]+|nth-child|nth-of-type|text|href|attr_id|attr_class)=")/;

/** Split on `;` outside quotes. */
function splitChain(chain: string): string[] {
  const out: string[] = [];
  let cur = "", inStr = false, esc = false;
  for (const c of chain) {
    if (inStr) {
      cur += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseElementsChain(chain: string): ChainElement[] {
  return splitChain(chain).map((raw) => {
    const m = ATTR_START.exec(raw);
    const head = m ? raw.slice(0, m.index) : raw;
    const rest = m ? raw.slice(m.index + 1) : "";
    const [tag, ...classes] = head.split(".");
    const attrs: Record<string, string> = {};
    for (const a of rest.matchAll(/([\w-]+)="((?:[^"\\]|\\.)*)"/g)) attrs[a[1]] = a[2].replace(/\\"/g, '"');
    return { tag: tag || "*", classes: classes.filter(Boolean), attrs, ...(attrs.text ? { text: attrs.text } : {}) };
  });
}

export type ElementRef = {
  /** Readable selector for the clicked element: tag.classes[href] plus :has-text("…"). */
  selector: string;
  /** Its visible text, else the nearest ancestor's. */
  label?: string;
  tag: string;
};

/** The clicked element of a chain as a readable selector + label. */
export function describeElement(chain: string): ElementRef {
  const els = parseElementsChain(chain);
  const el = els[0] ?? { tag: "*", classes: [], attrs: {} };
  const href = el.attrs.attr__href ?? el.attrs.href;
  const selector =
    el.tag +
    el.classes.map((c) => `.${c}`).join("") +
    (href ? `[href="${href}"]` : "") +
    (el.attrs.attr__type ? `[type="${el.attrs.attr__type}"]` : "") +
    (el.text ? `:has-text("${el.text}")` : "");
  const label = el.text ?? els.slice(1).find((e) => e.text)?.text;
  return { selector, tag: el.tag, ...(label ? { label } : {}) };
}

/** Whether `inner`'s chain sits inside the element `outer` was clicked on (same tag and classes). */
export function chainContains(inner: string, outer: string): boolean {
  const o = parseElementsChain(outer)[0];
  if (!o) return false;
  return parseElementsChain(inner)
    .slice(1)
    .some((e) => e.tag === o.tag && e.classes.join(".") === o.classes.join("."));
}
