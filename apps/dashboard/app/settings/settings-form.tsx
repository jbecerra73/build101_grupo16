"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Save, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError, getSettings, putSettings } from "@/lib/client/api";
import type { Settings } from "@/lib/control-types";

/** settings.json in the run store, read by the orchestrator when it takes a run. */
export function SettingsForm() {
  const [s, setS] = useState<Settings | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    getSettings().then(setS, (e) => setErrors([e instanceof Error ? e.message : String(e)]));
  }, []);
  if (!s) return errors.length ? <p className="text-destructive">{errors[0]}</p> : <Skeleton className="h-96 max-w-2xl" />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      setS(await putSettings(s!));
      toast.success("Settings saved. They apply to the next run the orchestrator takes.");
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : [String(err)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Orchestrator</CardTitle>
          <CardDescription>Which swarm and fix loop the next run uses, and the caps.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Swarm runner</FieldLabel>
                <FieldDescription>Offline simulates the agents with posthog-sim; tenki runs real browsers and spends credits.</FieldDescription>
              </FieldContent>
              <ToggleGroup type="single" variant="outline" value={s.swarmRunner} onValueChange={(v) => v && set("swarmRunner", v as Settings["swarmRunner"])}>
                <ToggleGroupItem value="offline">offline</ToggleGroupItem>
                <ToggleGroupItem value="tenki">tenki</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel>Fix loop</FieldLabel>
                <FieldDescription>Fake is the rehearsal (no PR). Real is P1&apos;s coding agent and opens PRs.</FieldDescription>
              </FieldContent>
              <ToggleGroup type="single" variant="outline" value={s.fixLoop} onValueChange={(v) => v && set("fixLoop", v as Settings["fixLoop"])}>
                <ToggleGroupItem value="fake">fake</ToggleGroupItem>
                <ToggleGroupItem value="real">real</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="speed">Offline swarm speed</FieldLabel>
              <Input id="speed" type="number" min={0.1} max={20} step={0.1} value={s.swarmSpeed} onChange={(e) => set("swarmSpeed", Number(e.target.value))} className="max-w-32" />
              <FieldDescription>1 ≈ 30 s of swarm on screen. 0.1 to 20.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="cap">Runs per day</FieldLabel>
              <Input id="cap" type="number" min={0} max={200} step={1} value={s.maxRunsPerDay} onChange={(e) => set("maxRunsPerDay", Number(e.target.value))} className="max-w-32" />
            </Field>
            <Field>
              <FieldLabel htmlFor="seeds">Default re-test seeds per persona</FieldLabel>
              <Input id="seeds" type="number" min={1} max={10} step={1} value={s.defaultSeedsPerPersona} onChange={(e) => set("defaultSeedsPerPersona", Number(e.target.value))} className="max-w-32" />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          {errors.length > 0 && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Not saved</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy} className="self-start">
            {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
