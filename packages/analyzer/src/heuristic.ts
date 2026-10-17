// Deterministic findings: strong signals clustered by step, evidence computed from the
// sessions behind them. Also the evidence builder the Sonnet path uses, so both paths
// report the same numbers for the same signals.
import { SEGMENTS, type Finding, type Flow, type RunKind, type SegmentId, type Severity } from "@frictionswarm/shared";
import { chainContains, describeElement } from "./elements";
import { AFFECTED_SHARE, affectedGroups, groupOf, type Signal, type SignalGroup } from "./signals";
import type { SessionSummary } from "./sessions";

/** Order in which a cluster's signals explain it (first = primary). */
const PRIORITY: Signal["kind"][] = ["promo_wipe", "rage_click", "no_size", "failed_submit", "give_up", "drop_off"];
const byPriority = (a: Signal, b: Signal) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || b.sessions - a.sessions;

export type FindingContext = { flow: Flow; kind: RunKind; sessions: SessionSummary[]; minSessions?: number };

/** For each step, the click that most often took completers to the next step. */
export function exitActions(sessions: SessionSummary[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const s of sessions) {
    if (!s.valid) continue;
    for (const t of s.transitions) {
      const m = counts.get(t.from) ?? counts.set(t.from, new Map()).get(t.from)!;
      m.set(t.chain, (m.get(t.chain) ?? 0) + 1);
    }
  }
  return new Map([...counts].map(([step, m]) => [step, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
}

/** Segments (and their personas) for a set of signal groups. Retest groups are personas. */
export function segmentsFor(kind: RunKind, groupIds: string[]): { segments: SegmentId[]; personas: string[] } {
  const segments = SEGMENTS.filter((s) => (kind === "retest" ? groupIds.includes(s.personaId) : groupIds.includes(s.id))).map((s) => s.id);
  return { segments, personas: segments.map((id) => SEGMENTS.find((s) => s.id === id)!.personaId) };
}

export const groupsOfSegments = (kind: RunKind, segments: SegmentId[]) =>
  SEGMENTS.filter((s) => segments.includes(s.id)).map((s) => (kind === "retest" ? s.personaId : s.id));

/** Which groups a cluster hurts: those affected by its primary signal, narrowed to those where
 * its step's drop-off is also high when that drop-off is itself a strong signal. */
export function clusterGroups(cluster: Signal[], minSessions: number, share = AFFECTED_SHARE): string[] {
  const sorted = cluster.toSorted(byPriority);
  const drop = cluster.find((s) => s.kind === "drop_off");
  // A failed form or a give-up hurts whoever leaves over it: judge those by the drop-off.
  const primary = drop?.strong && (sorted[0].kind === "failed_submit" || sorted[0].kind === "give_up") ? drop : sorted[0];
  const a = (primary.kind === "drop_off" ? dropOffGroups(primary, minSessions, share) : affectedGroups(primary, minSessions, share)).map((g) => g.id);
  if (!drop || drop === primary || !drop.strong) return a.length ? a : worst(primary);
  const b = new Set(dropOffGroups(drop, minSessions, share).map((g) => g.id));
  const both = a.filter((g) => b.has(g));
  return both.length ? both : a.length ? a : worst(primary);
}

/** Groups a drop-off hurts. With an abnormal dwell (e.g. leaving seconds after a page loads),
 * every group that shows the same pattern; otherwise the groups with the highest drop-off. */
export function dropOffGroups(drop: Signal, minSessions: number, share = AFFECTED_SHARE): SignalGroup[] {
  const d = drop.dwell;
  if (d && d.class !== "normal") {
    const same = drop.groups.filter(
      (g) =>
        g.sessions >= minSessions &&
        g.rate >= 0.05 &&
        g.exitDwellMs !== undefined &&
        (d.class === "short" ? g.exitDwellMs < 0.5 * d.passMedianMs : g.exitDwellMs > 2 * d.passMedianMs),
    );
    if (same.length) return same.sort((a, b) => b.rate - a.rate);
  }
  return affectedGroups(drop, minSessions, share);
}

/** Share of the worst group's rate that makes a group "affected". A swarm is small and
 * goal-directed, so any persona that hit the problem counts. */
export const shareFor = (kind: RunKind) => (kind === "retest" ? 0 : AFFECTED_SHARE);
const worst = (s: Signal) => (s.groups.toSorted((x, y) => y.rate - x.rate)[0] ? [s.groups.toSorted((x, y) => y.rate - x.rate)[0].id] : []);

const sum = (gs: SignalGroup[], f: (g: SignalGroup) => number) => gs.reduce((n, g) => n + f(g), 0);

/** Evidence for a finding from the signals it cites, restricted to its groups. */
export function buildEvidence(ctx: FindingContext, cited: Signal[], groupIds: string[], step: string): Finding["evidence"] {
  const group = groupOf(ctx.kind);
  const inGroups = new Set(ctx.sessions.filter((s) => groupIds.includes(group(s))).map((s) => s.id));
  const byId = new Map(ctx.sessions.map((s) => [s.id, s]));
  // Ordinary drop-off (browsing exits) isn't evidence of the problem; an abnormal one is.
  const nonDrop = cited.filter((s) => s.kind !== "drop_off" || s.strong);
  const basis = nonDrop.length ? nonDrop : cited;
  const ids = [...new Set(basis.flatMap((s) => s.sessionIds))].filter((id) => inGroups.has(id));
  const affected = ids.map((id) => byId.get(id)!).filter(Boolean);
  const exitedHere = (s: SessionSummary) => !s.valid && s.lastStep === step;
  const examples = affected.toSorted((a, b) => Number(exitedHere(b)) - Number(exitedHere(a)) || a.start - b.start).slice(0, 3).map((s) => s.id);
  const drop = cited.find((s) => s.kind === "drop_off" && s.step === step);
  const dropGroups = drop?.groups.filter((g) => groupIds.includes(g.id)) ?? [];
  const reached = sum(dropGroups, (g) => g.reached);
  const rage = cited.filter((s) => s.kind === "rage_click");
  const since = cited.toSorted(byPriority).find((s) => s.sinceRelease)?.sinceRelease;
  const quotes = [...new Set(cited.toSorted(byPriority).flatMap((s) => s.quotes))].slice(0, 4);
  return {
    sessions: affected.length,
    users: new Set(affected.map((s) => s.distinctId)).size,
    ...(drop && reached ? { dropOffRate: round(sum(dropGroups, (g) => g.sessions) / reached) } : {}),
    ...(rage.length ? { rageClicks: rage.reduce((n, s) => n + s.events, 0) } : {}),
    ...(since ? { sinceRelease: since } : {}),
    exampleSessions: examples,
    quotes,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Cluster signals into findings (strong signals by step; a wiped form is its own cluster),
 * ranked by the sessions lost at the step. */
export function heuristicFindings(ctx: FindingContext, signals: Signal[]): Finding[] {
  const minSessions = ctx.minSessions ?? (ctx.kind === "retest" ? 1 : 3);
  const clusters = new Map<string, Signal[]>();
  const add = (k: string, s: Signal) => clusters.set(k, [...(clusters.get(k) ?? []), s]);
  for (const s of signals.filter((s) => s.strong && s.kind !== "drop_off")) add(s.kind === "promo_wipe" ? `${s.step}#form` : s.step, s);
  for (const s of signals.filter((s) => s.kind === "drop_off")) {
    if (clusters.has(s.step)) add(s.step, s);
    else if (s.strong) add(s.step, s);
    else if (clusters.has(`${s.step}#form`)) add(`${s.step}#form`, s);
  }
  const exits = exitActions(ctx.sessions);
  const deliveryFee = ctx.sessions.find((s) => s.deliveryFee)?.deliveryFee;
  const group = groupOf(ctx.kind);

  const drafts = [...clusters.values()].map((cluster) => {
    const sorted = cluster.toSorted(byPriority);
    const primary = sorted[0];
    const step = primary.step;
    const groupIds = clusterGroups(cluster, minSessions, shareFor(ctx.kind));
    const { segments, personas } = segmentsFor(ctx.kind, groupIds);
    const evidence = buildEvidence(ctx, cluster, groupIds, step);
    const ids = evidenceIds(cluster);
    const mine = ctx.sessions.filter((s) => groupIds.includes(group(s)));
    const lost = mine.filter((s) => !s.valid && s.lastStep === step && ids.has(s.id)).length;
    const reached = mine.filter((s) => s.steps.includes(step)).length;
    const hit = mine.filter((s) => ids.has(s.id)).length;
    // share: of everyone at the step, how many this cost; blocking: of those who hit it, how many left
    const share = reached ? lost / reached : 0;
    const blocking = hit ? lost / hit : 0;
    const severity: Severity =
      ctx.kind === "retest"
        ? cluster.some((s) => s.kind === "give_up") ? "high" : "medium"
        : share >= 0.15 || (blocking >= 0.5 && share >= 0.03) ? "high" : share >= 0.03 || blocking >= 0.3 ? "medium" : "low";
    const text = describe(ctx.flow, cluster, segments, exits.get(step), deliveryFee);
    return {
      lost,
      finding: {
        id: "",
        severity,
        segments,
        personas,
        step,
        page: primary.page,
        ...(text.selector ? { selector: text.selector } : {}),
        title: text.title,
        evidence,
        suggestedFix: text.fix,
      } satisfies Finding,
    };
  });
  const rank = { high: 0, medium: 1, low: 2 };
  return drafts
    .filter((d) => d.finding.segments.length)
    .sort((a, b) => rank[a.finding.severity] - rank[b.finding.severity] || b.lost - a.lost || b.finding.evidence.sessions - a.finding.evidence.sessions)
    .map((d, i) => ({ ...d.finding, id: `F${i + 1}` }));
}

const evidenceIds = (cluster: Signal[]) => new Set(cluster.flatMap((s) => s.sessionIds));

const SEGMENT_NAMES: Record<SegmentId, string> = { low_vision: "Large-text users", mobile: "Mobile shoppers", desktop: "Desktop shoppers" };
const who = (segments: SegmentId[]) =>
  segments.length === SEGMENTS.length ? "Shoppers" : segments.map((s) => SEGMENT_NAMES[s]).join(" and ");

/** Title, selector and fix for a cluster, from what its signals are. */
export function describe(
  flow: Flow,
  cluster: Signal[],
  segments: SegmentId[],
  exitChain: string | undefined,
  deliveryFee: number | undefined,
): { title: string; fix: string; selector?: string } {
  const kinds = new Set(cluster.map((s) => s.kind));
  const primary = cluster.toSorted(byPriority)[0];
  const step = primary.step;
  const drop = cluster.find((s) => s.kind === "drop_off");
  const required = flow.required.steps.includes(step);
  const exit = exitChain ? describeElement(exitChain) : undefined;
  const people = who(segments);

  if (primary.kind === "promo_wipe")
    return {
      title: `Applying a promo code wipes the ${step.toLowerCase()} form: the next submit fails on ${primary.fields?.length ?? "all"} fields`,
      fix: `Keep the ${step.toLowerCase()} form's values when a promo code is applied (don't reset or re-mount the form), and keep the code applied.`,
    };
  if (primary.kind === "rage_click") {
    const label = primary.label;
    const nonControl = !["button", "a", "input", "select"].includes(describeElement(primary.chain ?? "").tag);
    if (kinds.has("no_size"))
      return {
        title: `${people} can't pick a size: '${label ?? "Size"}' gets rage clicks and Add to Cart is pressed without a size`,
        fix: "Show every size as a visible button that works on tap and without hover, and say which size is missing when Add to Cart is pressed.",
        selector: primary.selector,
      };
    if (!label && exit && primary.chain && exitChain && chainContains(exitChain, primary.chain))
      return {
        title: `${people} can't find '${exit.label ?? "the next step"}' on ${step}: rage clicks around it${drop?.dwell?.class === "long" ? ", long dwell" : ""}, then they leave`,
        fix: `Make '${exit.label ?? "the next step"}' a high-contrast, full-width primary button with readable text (at least 16px, WCAG AA contrast).`,
        selector: exit.selector,
      };
    return {
      title: `Rage clicks on ${label ? `'${label}'` : primary.selector} at ${step}`,
      fix: nonControl
        ? `'${label ?? primary.selector}' looks clickable but isn't: make it a real control (button/link) that responds on the first tap, or restyle it so it doesn't look interactive.`
        : `Make '${label ?? primary.selector}' respond visibly on the first click (state change, feedback or navigation).`,
      selector: primary.selector,
    };
  }
  if (primary.kind === "no_size")
    return {
      title: `${people} press Add to Cart without a size at ${step}`,
      fix: "Show the sizes as visible buttons (no hover needed) and point at the missing size when Add to Cart is pressed.",
    };
  if (primary.kind === "failed_submit" && !required && drop)
    return {
      title: `${people} leave at ${step}, a step the flow doesn't require; ${primary.sessions} failed '${primary.event}' submits (${(primary.fields ?? []).slice(0, 3).join(", ")})`,
      fix: `Make ${step} optional (e.g. continue as a guest; offer it after the purchase): it isn't a required step, and its form fails people.`,
    };
  if (primary.kind === "failed_submit")
    return {
      title: `'${primary.event}' fails at ${step} and people leave (${(primary.fields ?? []).slice(0, 3).join(", ")})`,
      fix: `Validate ${(primary.fields ?? []).slice(0, 3).join(", ")} inline as people type, with plain-language hints, and keep what they entered.`,
    };
  if (primary.kind === "give_up")
    return {
      title: `${people} give up at ${step}${primary.quotes[0] ? `: "${primary.quotes[0]}"` : ""}`,
      fix: `Remove the blocker on ${primary.page} so shoppers can continue without extra effort.`,
      ...(exit && { selector: exit.selector }),
    };
  // drop_off alone
  const d = primary.dwell;
  if (d?.class === "short") {
    const fee = deliveryFee && /pay/i.test(step);
    return {
      title: `${people} leave ${step} seconds after it loads${fee ? ` (median ${Math.round(d.exitMedianMs / 1000)}s): the $${deliveryFee} delivery fee first appears here` : ` (median ${Math.round(d.exitMedianMs / 1000)}s vs ${Math.round(d.passMedianMs / 1000)}s for those who continue)`}`,
      fix: fee
        ? `Show the $${deliveryFee} delivery fee and the order total in the cart, before checkout, so ${step} holds no surprises.`
        : `Show what ${step} reveals (costs, requirements) earlier in the flow.`,
    };
  }
  if (!required)
    return {
      title: `${people} leave at ${step}, a step the flow doesn't require`,
      fix: `Make ${step} optional (e.g. continue as a guest): it isn't a required step.`,
    };
  return {
    title: `${people} ${d?.class === "long" ? "linger and then leave" : "drop off"} at ${step}`,
    fix: exit ? `Make '${exit.label ?? exit.selector}' obvious: a high-contrast, clearly labelled primary action.` : `Make the next action on ${step} obvious.`,
    ...(exit && { selector: exit.selector }),
  };
}
