import type { Flow } from "./contracts";

const globToRegExp = (glob: string) =>
  new RegExp(
    "^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "/?$",
  );

/** Whether `url` (absolute or path) matches a flow route pattern. */
export function matchesRoute(route: string, url: string): boolean {
  const u = new URL(url, "http://x");
  const [pathPattern, query] = route.split("?");
  if (!globToRegExp(pathPattern).test(u.pathname)) return false;
  if (!query) return true;
  const want = new URLSearchParams(query);
  for (const [k, v] of want) if (u.searchParams.get(k) !== v) return false;
  return true;
}

/** Resolve a URL to the flow's funnel step name; a route with a query wins. */
export function resolveStep(flow: Flow, url: string): string | undefined {
  const matches = flow.steps.filter((s) => matchesRoute(s.route, url));
  return (matches.find((s) => s.route.includes("?")) ?? matches[0])?.name;
}
