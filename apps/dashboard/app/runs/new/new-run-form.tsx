"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Database, FileJson, Lock, ScanSearch, ShieldCheck, TriangleAlert } from "lucide-react";
import { FLOWS, PERSONAS, SEGMENTS, type Flow, type PostHogSourceKind, type Release, type StartRunRequest } from "@frictionswarm/shared";
import { PersonaAvatar } from "@/components/persona/avatar";
import { PersonaConstraints } from "@/components/persona-constraints";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { listFlows, startRun } from "@/lib/client/api";
import { segmentColor, segmentShort, shortDate } from "@/lib/format";

const AGENTS_PER_SANDBOX = 6;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

type Preset = { id: string; label: string; detail: string; window?: { from: string; to: string } };

/** Window presets: the default (current release, last 28 days), one per
 * release from the trend data, and a custom range. */
function presets(releases: Release[], today: string): Preset[] {
  const end = iso(Date.parse(`${today}T00:00:00Z`) + DAY);
  const out: Preset[] = [
    { id: "default", label: "Current release · last 28 days", detail: `${shortDate(iso(Date.parse(end) - 28 * DAY))} – ${shortDate(today)}, production build only` },
  ];
  releases.forEach((r, i) => {
    const to = releases[i + 1]?.date ?? end;
    out.push({ id: r.sha, label: r.name, detail: `${shortDate(r.date)} – ${shortDate(iso(Date.parse(to) - DAY))}`, window: { from: r.date, to } });
  });
  out.push({ id: "custom", label: "Custom range", detail: "Pick the dates" });
  return out;
}

export function NewRunForm({ releases, today, defaultSource }: { releases: Release[]; today: string; defaultSource: PostHogSourceKind }) {
  const router = useRouter();
  // The seed flows until GET /api/flows answers with the store's (custom flows included).
  const [flows, setFlows] = useState<Flow[]>(Object.values(FLOWS));
  const [flowId, setFlowId] = useState(flows[0].id);
  useEffect(() => {
    listFlows()
      .then((all) => all.length && setFlows(all))
      .catch(() => {});
  }, []);
  const options = presets(releases, today);
  const [preset, setPreset] = useState("default");
  const [from, setFrom] = useState(iso(Date.parse(`${today}T00:00:00Z`) - 27 * DAY));
  const [to, setTo] = useState(today);
  const [source, setSource] = useState<PostHogSourceKind>(defaultSource);
  const [seeds, setSeeds] = useState(10);
  const [autoFix, setAutoFix] = useState(true);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const flow = flows.find((f) => f.id === flowId) ?? flows[0];
  const personas = SEGMENTS.map((s) => PERSONAS[s.personaId]).filter(Boolean);
  const total = seeds * personas.length;
  const chosen = options.find((o) => o.id === preset)!;
  // Custom "to" is inclusive in the UI; the request's window is [from, to).
  const window = preset === "custom" ? { from, to: iso(Date.parse(`${to}T00:00:00Z`) + DAY) } : chosen.window;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErrors([]);
    const body: StartRunRequest = { flowId, ...(window ? { window } : {}), source, autoFix, ...(autoFix ? { seedsPerPersona: seeds } : {}) };
    try {
      const { runId } = await startRun(body);
      router.push(`/runs/${runId}`);
    } catch (err) {
      const errs = (err as { errors?: string[] }).errors;
      setErrors(errs?.length ? errs : [err instanceof Error ? err.message : String(err)]);
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">1. Flow</CardTitle>
            <CardDescription>The funnel the report measures: PostHog page views map to these steps.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="flow">Flow</FieldLabel>
                <Select value={flowId} onValueChange={setFlowId}>
                  <SelectTrigger id="flow" className="w-full max-w-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {flows.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.goal}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Store</dt>
              <dd>
                <code className="font-mono text-sm">{flow.startUrl}</code>
              </dd>
              <dt className="text-muted-foreground">Funnel steps</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                {flow.steps.map((s, i) => {
                  const req = flow.required.steps.includes(s.name);
                  return (
                    <span key={s.route} className="inline-flex items-center gap-1.5">
                      {i > 0 && <span className="text-muted-foreground">→</span>}
                      <Badge variant={req ? "default" : "outline"} title={s.route}>
                        {req && <Lock data-icon="inline-start" />}
                        {s.name}
                      </Badge>
                    </span>
                  );
                })}
              </dd>
              <dt className="text-muted-foreground">Completion</dt>
              <dd className="text-sm">
                Reached {flow.required.steps.join(", ")}, shipping and payment submitted successfully, and <code className="font-mono">order_completed</code> fired.
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2. Analysis window</CardTitle>
            <CardDescription>Real users only (no swarm traffic), split into segments. Releases come from the trend data.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <RadioGroup value={preset} onValueChange={setPreset} className="grid gap-2 sm:grid-cols-2" aria-label="Analysis window">
              {options.map((o) => (
                <FieldLabel key={o.id} htmlFor={`w-${o.id}`} className="cursor-pointer">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{o.label}</FieldTitle>
                      <FieldDescription>{o.detail}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem value={o.id} id={`w-${o.id}`} />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
            {preset === "custom" && (
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="from">From</FieldLabel>
                  <Input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="to">To (inclusive)</FieldLabel>
                  <Input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </FieldGroup>
            )}
            <FieldSet>
              <FieldLegend variant="label">PostHog source</FieldLegend>
              <ToggleGroup type="single" variant="outline" value={source} onValueChange={(v) => v && setSource(v as PostHogSourceKind)} className="w-fit">
                <ToggleGroupItem value="file" className="px-4">
                  <FileJson data-icon="inline-start" />
                  File export
                </ToggleGroupItem>
                <ToggleGroupItem value="api" className="px-4">
                  <Database data-icon="inline-start" />
                  PostHog API
                </ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {source === "file"
                  ? "Offline: data/posthog/events.jsonl, PostHog's export shape (npm run posthog:generate)."
                  : "Live: HogQL against the project (POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST)."}
              </FieldDescription>
            </FieldSet>
            <div className="flex flex-wrap gap-2 text-sm">
              {SEGMENTS.map((s) => (
                <Badge key={s.id} variant="outline" className="gap-1.5">
                  <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: segmentColor(s.id) }} />
                  {segmentShort(s.id)}
                  {s.name !== segmentShort(s.id) && <span className="text-muted-foreground">· {s.name}</span>}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">3. Re-test personas</CardTitle>
            <CardDescription>
              With auto-fix on, a swarm stands in for each segment on the fix&apos;s preview. Constraints are enforced on what the agent can see and do.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-3">
            {personas.map((p) => {
              const seg = SEGMENTS.find((s) => s.personaId === p.id)!;
              return (
                <Card key={p.id} className="h-full border-t-4" style={{ borderTopColor: segmentColor(seg.id) }}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-3 text-base">
                      <PersonaAvatar personaId={p.id} size={48} mood={autoFix ? "running" : "idle"} label="" />
                      {p.name}
                    </CardTitle>
                    <CardDescription>Stands in for {segmentShort(seg.id).toLowerCase()} users</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {p.control && (
                      <Badge variant="secondary">
                        <ShieldCheck data-icon="inline-start" />
                        Control: must not regress
                      </Badge>
                    )}
                    <PersonaConstraints persona={p} />
                  </CardContent>
                </Card>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-6 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">4. Analyze</CardTitle>
            <CardDescription>The report comes from PostHog alone; the swarm only runs to verify a fix.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="autofix">Auto-fix top findings</FieldLabel>
                  <FieldDescription>Coding agent opens a draft PR; the persona swarm re-tests the preview and the verdict compares it to each segment.</FieldDescription>
                </FieldContent>
                <Switch id="autofix" checked={autoFix} onCheckedChange={setAutoFix} />
              </Field>
              <Field data-disabled={!autoFix || undefined}>
                <div className="flex items-baseline justify-between">
                  <FieldLabel htmlFor="seeds">Re-test seeds per persona</FieldLabel>
                  <span className="tabular text-2xl font-semibold">{seeds}</span>
                </div>
                <Slider id="seeds" min={1} max={10} step={1} value={[seeds]} onValueChange={([v]) => setSeeds(v)} disabled={!autoFix} />
                <FieldDescription>Fresh, never-used seeds. More seeds, less noise, more API spend.</FieldDescription>
              </Field>
              {autoFix && (
                <div className="flex items-end justify-between rounded-lg bg-muted px-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-sm text-muted-foreground">Re-test agents</span>
                    <span className="text-xs text-muted-foreground">
                      {personas.length} personas × {seeds} seeds · ~{Math.max(1, Math.ceil(total / AGENTS_PER_SANDBOX))} sandboxes
                    </span>
                  </div>
                  <span className="tabular text-4xl font-semibold">{total}</span>
                </div>
              )}
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {errors.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Could not start the analysis</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" disabled={pending} className="h-11 text-base">
              {pending ? <Spinner data-icon="inline-start" /> : <ScanSearch data-icon="inline-start" />}
              {autoFix ? "Analyze, fix and re-test" : "Analyze"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </form>
  );
}
