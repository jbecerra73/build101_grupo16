"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Gauge, History, ScanSearch, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

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

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Runs", icon: History },
  { href: "/control", label: "Control", icon: Gauge },
];

const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" || (pathname.startsWith("/runs/") && pathname !== "/runs/new") : pathname.startsWith(href);

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active && "bg-sidebar-accent text-sidebar-foreground",
      )}
    >
      <Icon className={cn("size-4", active && "text-sidebar-primary")} aria-hidden />
      {label}
    </Link>
  );
}

/** PostHog-style app chrome: a left nav rail on desktop, a compact top bar on small screens. */
export function SiteHeader() {
  const pathname = usePathname();
  return (
    <>
      <aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar p-3 md:flex">
        <Link href="/" className="flex items-center gap-2 px-1.5 py-1 font-semibold tracking-tight">
          <Logo />
          <span>FrictionSwarm</span>
        </Link>
        <Button asChild className="w-full justify-start">
          <Link href="/runs/new">
            <ScanSearch data-icon="inline-start" />
            Analyze
          </Link>
        </Button>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          <span className="px-2.5 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Project</span>
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} active={isActive(pathname, n.href)} />
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between border-t border-sidebar-border pt-3 pl-1.5">
          <span className="text-xs text-muted-foreground">Theme</span>
          <ThemeToggle />
        </div>
      </aside>

      <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b bg-sidebar px-4 md:hidden">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo />
          <span className="sr-only">FrictionSwarm</span>
        </Link>
        <nav className="flex items-center gap-0.5" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.href} {...n} active={isActive(pathname, n.href)} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <Button asChild size="sm">
            <Link href="/runs/new">
              <ScanSearch data-icon="inline-start" />
              Analyze
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </header>
    </>
  );
}
