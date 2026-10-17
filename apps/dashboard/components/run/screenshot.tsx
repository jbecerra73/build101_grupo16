"use client";

import { ImageOff } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** URL of a file in a run folder. `version` busts the cache of a screenshot that is rewritten as its agent moves. */
export const fileUrl = (runId: string, path: string, version?: string) =>
  `/api/runs/${encodeURIComponent(runId)}/files/${path.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${encodeURIComponent(version)}` : ""}`;

export function Shot({ runId, path, version, alt, className }: { runId: string; path?: string; version?: string; alt: string; className?: string }) {
  if (!path)
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)}>
        <ImageOff className="size-6" aria-hidden />
        <span className="sr-only">No screenshot yet</span>
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- run screenshots come from the run store API
    <img src={fileUrl(runId, path, version)} alt={alt} className={cn("bg-muted object-cover object-top", className)} />
  );
}

/** Thumbnail that opens the full screenshot in a dialog. */
export function ShotDialog({
  runId,
  path,
  title,
  description,
  children,
  className,
}: {
  runId: string;
  path: string;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn("group relative overflow-hidden rounded-md ring-1 ring-foreground/10 outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}
          aria-label={`Open screenshot: ${title}`}
        >
          <Shot runId={runId} path={path} alt={title} className="size-full transition-transform group-hover:scale-[1.02]" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Shot runId={runId} path={path} alt={title} className="max-h-[70vh] w-full rounded-md object-contain" />
        {children}
      </DialogContent>
    </Dialog>
  );
}
