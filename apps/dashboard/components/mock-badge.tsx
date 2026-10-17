"use client";

import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Marks numbers the dashboard estimated rather than read (e.g. a sandbox
 * layout rebuilt from the agents when swarm.json is missing). */
export function MockBadge({ what, label = "Estimated" }: { what: string; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1.5 border-dashed text-muted-foreground" tabIndex={0}>
          <FlaskConical data-icon="inline-start" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{what}</TooltipContent>
    </Tooltip>
  );
}
