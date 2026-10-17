"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Password form for the dashboard gate (proxy.ts + lib/auth.ts). */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get("next");
      // Only same-site paths.
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      return;
    }
    setError(res.status === 401 ? "Wrong password" : "Could not sign in");
    setPending(false);
  }

  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4" /> FrictionSwarm
          </CardTitle>
          <CardDescription>Enter the dashboard password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={pending || !password}>
              {pending ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
