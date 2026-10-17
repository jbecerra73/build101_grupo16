"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lock, Rocket, ShieldCheck, TriangleAlert } from "lucide-react";
import { FLOWS, PERSONAS, type StartRunRequest } from "@frictionswarm/shared";
import { PersonaAvatar } from "@/components/persona/avatar";
import { PersonaConstraints } from "@/components/persona-constraints";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const AGENTS_PER_SANDBOX = 6;

export function NewRunForm() {
  const router = useRouter();
  const flowIds = Object.keys(FLOWS);
  const [flowId, setFlowId] = useState(flowIds[0]);
  const [personaIds, setPersonaIds] = useState<string[]>(Object.keys(PERSONAS));
  const [seeds, setSeeds] = useState(10);
  const [autoFix, setAutoFix] = useState(true);
  const [targetUrl, setTargetUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const flow = FLOWS[flowId];
  const total = seeds * personaIds.length;
  const toggle = (id: string, on: boolean) =>
    setPersonaIds((ids) => (on ? Object.keys(PERSONAS).filter((p) => p === id || ids.includes(p)) : ids.filter((p) => p !== id)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErrors([]);
    const body: StartRunRequest = { flowId, personaIds, seedsPerPersona: seeds, autoFix, ...(targetUrl ? { targetUrl } : {}) };
    try {
      const res = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error((json.errors ?? ["Failed to start run"]).join("\n"));
      router.push(`/runs/${json.runId}`);
    } catch (err) {
      setErrors((err instanceof Error ? err.message : String(err)).split("\n"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-6">
        {/* Flow */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">1. Flow</CardTitle>
            <CardDescription>A natural-language goal, a start URL and an unambiguous success condition.</CardDescription>
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
                      {flowIds.map((id) => (
                        <SelectItem key={id} value={id}>
                          {FLOWS[id].goal}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Goal</dt>
              <dd className="text-lg font-medium">{flow.goal}</dd>
              <dt className="text-muted-foreground">Start URL</dt>
              <dd>
                <code className="font-mono text-sm">{flow.startUrl}</code>
              </dd>
              <dt className="text-muted-foreground">Success when</dt>
              <dd className="flex flex-wrap gap-2">
                {flow.success.urlPattern && (
                  <Badge variant="secondary">
                    URL matches <code className="font-mono">{flow.success.urlPattern}</code>
                  </Badge>
                )}
                {flow.success.visibleText && <Badge variant="secondary">shows “{flow.success.visibleText}”</Badge>}
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
              <dt className="text-muted-foreground">Required fields</dt>
              <dd className="flex flex-wrap gap-1.5">
                {flow.required.fields.map((f) => (
                  <Badge key={f} variant="outline">
                    <Lock data-icon="inline-start" />
                    {f}
                  </Badge>
                ))}
              </dd>
            </dl>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="size-4" aria-hidden />
              Locked steps and fields are verified in every completion and cannot be removed by the coding agent.
            </p>
          </CardContent>
        </Card>

        {/* Personas */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2. Personas</CardTitle>
            <CardDescription>
              Constraints are enforced on the agent&apos;s perception and actions, not just written in its prompt.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-3">
            {Object.values(PERSONAS).map((p) => {
              const on = personaIds.includes(p.id);
              return (
                <label key={p.id} htmlFor={`persona-${p.id}`} className="cursor-pointer">
                  <Card
                    className={cn(
                      "h-full border-t-4 transition-shadow",
                      on ? "ring-2 ring-primary" : "opacity-60 hover:opacity-90",
                    )}
                    style={{ borderTopColor: `var(--persona-${p.id}, var(--persona-other))` }}
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-base">
                        <PersonaAvatar personaId={p.id} size={48} mood={on ? "running" : "idle"} label="" />
                        {p.name}
                      </CardTitle>
                      <CardDescription className="line-clamp-3">{p.prompt}</CardDescription>
                      <CardAction>
                        <Checkbox id={`persona-${p.id}`} checked={on} onCheckedChange={(v) => toggle(p.id, v === true)} />
                      </CardAction>
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
                </label>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* Launch */}
      <div className="flex flex-col gap-6 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">3. Launch</CardTitle>
            <CardDescription>Fresh seeds per persona; every agent is an independent browser session.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <div className="flex items-baseline justify-between">
                  <FieldLabel htmlFor="seeds">Seeds per persona</FieldLabel>
                  <span className="tabular text-2xl font-semibold">{seeds}</span>
                </div>
                <Slider id="seeds" min={1} max={10} step={1} value={[seeds]} onValueChange={([v]) => setSeeds(v)} />
                <FieldDescription>1 to 10. More seeds means less noisy results and more API spend.</FieldDescription>
              </Field>
              <div className="flex items-end justify-between rounded-lg bg-muted px-4 py-3">
                <div className="flex flex-col">
                  <span className="text-sm text-muted-foreground">Total agents</span>
                  <span className="text-xs text-muted-foreground">
                    {personaIds.length} persona{personaIds.length === 1 ? "" : "s"} × {seeds} seeds · ~
                    {Math.max(1, Math.ceil(total / AGENTS_PER_SANDBOX))} sandboxes
                  </span>
                </div>
                <span className="tabular text-4xl font-semibold">{total}</span>
              </div>
              <Field>
                <FieldLabel htmlFor="target">Target URL</FieldLabel>
                <Input id="target" type="url" placeholder={flow.startUrl} value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
                <FieldDescription>Defaults to production. Its build-sha is verified before the swarm starts.</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="autofix">Auto-fix top findings</FieldLabel>
                  <FieldDescription>Coding agent opens a draft PR, then the same personas retest the preview with fresh seeds.</FieldDescription>
                </FieldContent>
                <Switch id="autofix" checked={autoFix} onCheckedChange={setAutoFix} />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            {errors.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Could not start the run</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" disabled={pending || personaIds.length === 0} className="h-11 text-base">
              {pending ? <Spinner data-icon="inline-start" /> : <Rocket data-icon="inline-start" />}
              Start swarm · {total} agents
            </Button>
          </CardFooter>
        </Card>
      </div>
    </form>
  );
}
