import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { themeInitScript } from "@/components/theme-toggle";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "FrictionSwarm",
  description: "A CI check for UX: persona swarms find friction, a coding agent fixes it, a retest proves it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-background md:flex-row">
        <TooltipProvider>
          <SiteHeader />
          <main className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-1 flex-col gap-6 px-4 py-6 md:px-8">{children}</main>
          <Toaster richColors={false} />
        </TooltipProvider>
      </body>
    </html>
  );
}
