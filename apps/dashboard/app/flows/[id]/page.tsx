import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getFlow } from "@frictionswarm/store";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { runStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Flow · FrictionSwarm" };

/** Read-only view of a flow in the same order the MCP's flow card uses: goal, start URL, success, steps, required fields. */
export default async function FlowPage(props: PageProps<"/flows/[id]">) {
  const { id } = await props.params;
  const flow = await getFlow(runStore(), id);
  if (!flow) notFound();
  const success = [flow.success.urlPattern && `URL matches ${flow.success.urlPattern}`, flow.success.visibleText && `page shows "${flow.success.visibleText}"`].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <nav className="text-sm text-muted-foreground">
          <Link href="/" className="hover:underline">
            Runs
          </Link>{" "}
          / flow / <span className="font-mono">{flow.id}</span>
        </nav>
        <h1 className="text-3xl font-semibold tracking-tight">{flow.goal}</h1>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Start URL</dt>
            <dd>
              <code className="font-mono text-sm">{flow.startUrl}</code>
            </dd>
            <dt className="text-muted-foreground">Success</dt>
            <dd>{success.join(" and ")}</dd>
            <dt className="text-muted-foreground">Required fields</dt>
            <dd className="flex flex-wrap gap-1.5">
              {flow.required.fields.length ? (
                flow.required.fields.map((f) => (
                  <Badge key={f} variant="outline" className="font-mono">
                    {f}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Steps</CardTitle>
          <CardDescription>Page views map to these steps. A lock marks a required step: the coding agent may not remove it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-2">
            {flow.steps.map((s, i) => (
              <li key={s.route} className="flex items-center gap-3">
                <span className="w-6 text-right tabular text-muted-foreground">{i + 1}.</span>
                <span className="font-medium">{s.name}</span>
                {flow.required.steps.includes(s.name) && <Lock className="size-3.5" aria-label="required step" />}
                <code className="font-mono text-sm text-muted-foreground">{s.route}</code>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
