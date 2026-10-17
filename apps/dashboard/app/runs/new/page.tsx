import { NewRunForm } from "./new-run-form";

export default function NewRunPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">New run</h1>
        <p className="text-muted-foreground">
          Pick a flow and the personas to swarm it. Each persona&apos;s constraints are enforced on what the agent can see and do.
        </p>
      </div>
      <NewRunForm />
    </div>
  );
}
