import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

function Logo() {
  // Three persona-colored dots in a swarm: the brand mark.
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
      <circle cx="7" cy="8" r="4" fill="var(--persona-rosa)" />
      <circle cx="17" cy="9" r="3.4" fill="var(--persona-kai)" />
      <circle cx="11" cy="17.5" r="3.8" fill="var(--persona-typical)" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          <span className="text-lg">FrictionSwarm</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Button variant="ghost" asChild>
            <Link href="/">Runs</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/control">Control</Link>
          </Button>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild>
            <Link href="/runs/new">
              <Plus data-icon="inline-start" />
              New run
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
