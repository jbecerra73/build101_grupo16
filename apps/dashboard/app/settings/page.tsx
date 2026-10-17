import type { Metadata } from "next";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings · FrictionSwarm" };

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Stored in the run store (settings.json); the orchestrator reads them for each new run.</p>
      </div>
      <SettingsForm />
    </div>
  );
}
