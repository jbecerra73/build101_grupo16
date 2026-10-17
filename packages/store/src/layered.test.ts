import { describe, expect, it } from "vitest";
import { FixtureFallbackStore, isFixtureKey, MemoryStore } from "./index";

async function setup() {
  const blobs = new MemoryStore();
  const repo = new MemoryStore();
  await repo.putJson("runs/fixture-proven/config.json", { runId: "fixture-proven" });
  await repo.putBytes("runs/fixture-proven/screenshots/a.png", new Uint8Array([1, 2]));
  await repo.putJson("runs/2026-10-17T00-00-00-abcd/config.json", { runId: "stale-local-run" });
  await repo.putJson("queue/x.json", { leaked: true });
  await blobs.putJson("runs/2026-10-18T00-00-00-beef/config.json", { runId: "live" });
  await blobs.putJson("settings.json", { swarmSpeed: 2 });
  return { blobs, repo, store: new FixtureFallbackStore(blobs, repo) };
}

describe("FixtureFallbackStore", () => {
  it("recognises fixture keys only", () => {
    expect(isFixtureKey("runs/fixture-proven/config.json")).toBe(true);
    expect(isFixtureKey("runs/fixture-proven/")).toBe(true);
    expect(isFixtureKey("runs/2026-10-18/config.json")).toBe(false);
    expect(isFixtureKey("queue/fixture-x.json")).toBe(false);
  });

  it("reads fixtures from the bundled repo copy and everything else from the primary", async () => {
    const { store } = await setup();
    expect(store.kind).toBe("memory");
    expect(await store.getJson("runs/fixture-proven/config.json")).toEqual({ runId: "fixture-proven" });
    expect(await store.getBytes("runs/fixture-proven/screenshots/a.png")).toEqual(new Uint8Array([1, 2]));
    expect(await store.getJson("runs/2026-10-17T00-00-00-abcd/config.json")).toBeUndefined();
    expect(await store.getJson("queue/x.json")).toBeUndefined();
    expect(await store.getJson("settings.json")).toEqual({ swarmSpeed: 2 });
  });

  it("lists the union, limited to fixture folders from the fallback", async () => {
    const { store } = await setup();
    expect(await store.listDirs("runs/")).toEqual(["2026-10-18T00-00-00-beef", "fixture-proven"]);
    expect(await store.list("runs/fixture-proven/")).toEqual(["runs/fixture-proven/config.json", "runs/fixture-proven/screenshots/a.png"]);
    expect(await store.list("queue/")).toEqual([]);
    expect(await store.list("runs/")).toEqual([
      "runs/2026-10-18T00-00-00-beef/config.json",
      "runs/fixture-proven/config.json",
      "runs/fixture-proven/screenshots/a.png",
    ]);
  });

  it("writes only to the primary; a primary copy shadows the fixture", async () => {
    const { store, blobs, repo } = await setup();
    await store.putJson("runs/fixture-proven/config.json", { runId: "shadowed" });
    expect(await store.getJson("runs/fixture-proven/config.json")).toEqual({ runId: "shadowed" });
    expect(await repo.getJson("runs/fixture-proven/config.json")).toEqual({ runId: "fixture-proven" });
    await store.delete("runs/fixture-proven/config.json");
    expect(await blobs.getJson("runs/fixture-proven/config.json")).toBeUndefined();
    expect(await store.getJson("runs/fixture-proven/config.json")).toEqual({ runId: "fixture-proven" });
  });
});
