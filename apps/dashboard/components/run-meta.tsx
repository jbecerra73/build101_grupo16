"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatFullDateTime, relativeTime, retestAttempt, runIdShort } from "@/lib/format";
import { useNow } from "@/lib/hooks/use-poll";
import { cn } from "@/lib/utils";

/** Run id as its last 4 characters (full id on hover), plus a label when it is a re-test. */
export function RunId({
  runId,
  href,
  retest,
  className,
}: {
  runId: string;
  href?: string;
  /** Forces the retest label for ids without the `-retestN` suffix. */
  retest?: boolean;
  className?: string;
}) {
  const attempt = retestAttempt(runId);
  const tag = (
    <span className="font-mono text-sm font-medium">
      <span className="text-muted-foreground">#</span>
      {runIdShort(runId)}
    </span>
  );
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          {href ? (
            <Link href={href} className="rounded-sm hover:underline hover:decoration-primary hover:underline-offset-4">
              {tag}
            </Link>
          ) : (
            <span tabIndex={0}>{tag}</span>
          )}
        </TooltipTrigger>
        <TooltipContent className="font-mono">{runId}</TooltipContent>
      </Tooltip>
      {(attempt !== undefined || retest) && (
        <Badge variant="highlight">
          <RotateCcw data-icon="inline-start" />
          Retest{attempt !== undefined ? ` ${attempt}` : ""}
        </Badge>
      )}
    </span>
  );
}

/** "Oct 17, 09:05 PM · 3 hours ago", ticking; exact timestamp on hover. `stacked` puts the "ago" on its own line. */
export function TimeAgo({ iso, stacked, className }: { iso: string; stacked?: boolean; className?: string }) {
  const now = useNow(30_000);
  if (!Number.isFinite(Date.parse(iso))) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={iso}
          tabIndex={0}
          className={cn("tabular inline-flex text-sm", stacked ? "flex-col" : "flex-wrap items-baseline gap-x-1.5", className)}
        >
          <span suppressHydrationWarning>{formatDateTime(iso)}</span>
          <span suppressHydrationWarning className={cn("text-muted-foreground", stacked && "text-xs")}>
            {stacked ? "" : "· "}
            {relativeTime(iso, now)}
          </span>
        </time>
      </TooltipTrigger>
      <TooltipContent suppressHydrationWarning>{formatFullDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}
