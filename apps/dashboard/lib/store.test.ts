import { FixtureFallbackStore } from "@frictionswarm/store";
import { describe, expect, it } from "vitest";
import { orchestratorMode } from "./orchestrator";
import { runsDir } from "./runs-dir";
import { makeRunStore } from "./store";

describe("makeRunStore", () => {
  it("uses the runs dir directly with RUN_STORE=fs", () => {
    expect(makeRunStore({ RUN_STORE: "fs" }).kind).toBe("fs");
  });
  it("layers the committed fixtures under Blobs", async () => {
    const store = makeRunStore({ RUN_STORE: "blobs", NETLIFY_SITE_ID: "site", NETLIFY_AUTH_TOKEN: "t" }, runsDir());
    expect(store).toBeInstanceOf(FixtureFallbackStore);
    expect(store.kind).toBe("blobs");
    const fallback = (store as FixtureFallbackStore).fallback;
    expect(await fallback.listDirs("runs/")).toContain("fixture-proven");
  });
});

describe("orchestratorMode", () => {
  it("is inline by default and queue on request (daemon is an alias)", () => {
    expect(orchestratorMode({})).toBe("inline");
    expect(orchestratorMode({ ORCHESTRATOR: "queue" })).toBe("queue");
    expect(orchestratorMode({ ORCHESTRATOR: "daemon" })).toBe("queue");
    expect(orchestratorMode({ NETLIFY: "true" })).toBe("queue");
  });
});
