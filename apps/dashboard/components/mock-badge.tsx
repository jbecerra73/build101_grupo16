"use client";

import { FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Marks UI fed by lib/client/mock.ts (backend routes not merged yet). Delete with it. */
export function MockBadge({ what }: { what: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1.5 border-dashed text-muted-foreground" tabIndex={0}>
          <FlaskConical data-icon="inline-start" />
          Mock data
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{what}</TooltipContent>
    </Tooltip>
  );
}
