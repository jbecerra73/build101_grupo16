import {
  Contrast,
  Eye,
  Gauge,
  Hand,
  Hourglass,
  Monitor,
  MousePointerClick,
  RotateCcw,
  ScanEye,
  Smartphone,
  Type,
  type LucideIcon,
} from "lucide-react";
import { MAX_ACTIONS_PER_AGENT, type Persona } from "@frictionswarm/shared";

type Row = { icon: LucideIcon; label: string; value: string };

/** The enforced constraints of a persona: the "why trust it" argument. These are
 * applied by the worker to what the model sees and can do, not just prompted. */
export function constraintRows(p: Persona): Row[] {
  const rows: Row[] = [];
  const v = p.viewport;
  rows.push({ icon: v.mobile ? Smartphone : Monitor, label: "Viewport", value: `${v.width}×${v.height} ${v.mobile ? "mobile" : "desktop"}` });
  rows.push({
    icon: Eye,
    label: "Perceives",
    value: p.perception.mode === "screenshot" ? "Screenshot only, no DOM text" : "Screenshot + accessibility tree",
  });
  const blur = [
    p.perception.blur ? `blur ${p.perception.blur}px` : "",
    p.perception.downscale && p.perception.downscale < 1 ? `downscaled to ${Math.round(p.perception.downscale * 100)}%` : "",
  ].filter(Boolean);
  if (blur.length) rows.push({ icon: ScanEye, label: "Vision filter", value: blur.join(", ") });
  if (p.perception.minContrast) rows.push({ icon: Contrast, label: "Contrast", value: `Text under ${p.perception.minContrast}:1 is invisible` });
  if (p.perception.minFontPx) rows.push({ icon: Type, label: "Font size", value: `Text under ${p.perception.minFontPx}px is invisible` });
  if (p.perception.hideHoverOnly) rows.push({ icon: MousePointerClick, label: "Hover", value: "Hover-only elements hidden" });
  if (p.actions.minTapTargetPx) rows.push({ icon: Hand, label: "Tap targets", value: `Under ${p.actions.minTapTargetPx}px register as misses` });
  rows.push({
    icon: Gauge,
    label: "Action budget",
    value: `${Math.min(p.actions.maxActions, MAX_ACTIONS_PER_AGENT)} actions (hard cap ${MAX_ACTIONS_PER_AGENT})`,
  });
  if (p.actions.maxRetriesSameTarget)
    rows.push({ icon: RotateCcw, label: "Retries", value: `Gives up after ${p.actions.maxRetriesSameTarget} failed tries on one target` });
  const c = p.patience.costs;
  rows.push({
    icon: Hourglass,
    label: "Patience",
    value: `${p.patience.start} pts; page load −${c.pageLoad}, modal −${c.modal}, error −${c.error}`,
  });
  return rows;
}

export function PersonaConstraints({ persona }: { persona: Persona }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 text-sm">
      {constraintRows(persona).map(({ icon: Icon, label, value }) => (
        <div key={label} className="contents">
          <dt className="flex items-center gap-2 text-muted-foreground">
            <Icon className="size-4" aria-hidden />
            {label}
          </dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
