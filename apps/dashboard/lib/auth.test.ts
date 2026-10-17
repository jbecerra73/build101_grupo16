import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { AUTH_COOKIE, checkPassword, gate, signSession, verifySession } from "./auth";

const env = { DASHBOARD_PASSWORD: "hunter2" };

describe("session cookie", () => {
  it("verifies its own signature, and rejects tampered, expired or foreign cookies", async () => {
    const now = 1_800_000_000;
    const c = await signSession(env, now);
    expect(await verifySession(c, env, now)).toBe(true);
    const [exp, sig] = c.split(".");
    expect(await verifySession(`${Number(exp) + 1}.${sig}`, env, now)).toBe(false);
    expect(await verifySession(`${exp}.${sig.replace(/^./, sig[0] === "a" ? "b" : "a")}`, env, now)).toBe(false);
    expect(await verifySession(c, env, Number(exp) + 1)).toBe(false);
    expect(await verifySession(c, { DASHBOARD_PASSWORD: "other" }, now)).toBe(false);
    expect(await verifySession("garbage", env, now)).toBe(false);
    expect(await verifySession(undefined, env, now)).toBe(false);
  });

  it("checks the password", async () => {
    expect(await checkPassword("hunter2", env)).toBe(true);
    expect(await checkPassword("hunter", env)).toBe(false);
    expect(await checkPassword(undefined, env)).toBe(false);
    expect(await checkPassword("anything", {})).toBe(false);
  });
});

describe("gate", () => {
  it("is off without DASHBOARD_PASSWORD", async () => {
    expect(await gate("/api/control", undefined, {})).toBe("allow");
    expect(await gate("/", undefined, {})).toBe("allow");
  });
  it("401s API calls and sends pages to /login without a valid cookie", async () => {
    expect(await gate("/api/control", undefined, env)).toBe("unauthorized");
    expect(await gate("/runs/abc", "1.bad", env)).toBe("login");
    expect(await gate("/login", undefined, env)).toBe("allow");
    expect(await gate("/api/login", undefined, env)).toBe("allow");
    expect(await gate("/api/control", await signSession(env), env)).toBe("allow");
  });
});

describe("proxy.ts", () => {
  const saved = process.env.DASHBOARD_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = saved;
  });

  it("enforces the gate on real requests", async () => {
    process.env.DASHBOARD_PASSWORD = "hunter2";
    const api = await proxy(new NextRequest("https://fs.example/api/runs"));
    expect(api.status).toBe(401);
    const page = await proxy(new NextRequest("https://fs.example/runs/r1?tab=x"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://fs.example/login?next=%2Fruns%2Fr1%3Ftab%3Dx");
    const authed = new NextRequest("https://fs.example/api/runs", { headers: { cookie: `${AUTH_COOKIE}=${await signSession()}` } });
    const ok = await proxy(authed);
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });

  it("lets everything through when no password is configured", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect((await proxy(new NextRequest("https://fs.example/api/runs"))).headers.get("x-middleware-next")).toBe("1");
  });
});

describe("POST /api/login", () => {
  it("sets the cookie on the right password only", async () => {
    process.env.DASHBOARD_PASSWORD = "hunter2";
    const { POST } = await import("@/app/api/login/route");
    const login = (password: string) => POST(new NextRequest("https://fs.example/api/login", { method: "POST", body: JSON.stringify({ password }) }));
    const bad = await login("nope");
    expect(bad.status).toBe(401);
    expect(bad.cookies.get(AUTH_COOKIE)).toBeUndefined();
    const good = await login("hunter2");
    expect(good.status).toBe(200);
    const cookie = good.cookies.get(AUTH_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(await verifySession(cookie.value)).toBe(true);
    delete process.env.DASHBOARD_PASSWORD;
  });
});
