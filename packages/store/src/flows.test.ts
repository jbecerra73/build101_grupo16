import { buyTshirt, FLOWS, type Flow } from "@frictionswarm/shared";
import { describe, expect, it } from "vitest";
import { diffFlows, flowHash, getFlow, listFlows, putFlow, validateFlow } from "./flows";
import { MemoryStore } from "./memory";

const errorsOf = (input: unknown) => {
  const r = validateFlow(input);
  if (r.ok) throw new Error("expected invalid");
  return r.errors;
};

describe("validateFlow", () => {
  it("lists every missing top-level field", () => {
    const r = validateFlow({});
    expect(r).toMatchObject({ ok: false, missing: ["id", "goal", "startUrl", "success", "steps", "required"] });
  });
  it("accepts the seed flow", () => {
    expect(validateFlow(buyTshirt)).toEqual({ ok: true, flow: buyTshirt });
  });
  it("accepts every seed flow (completion, attempt, doneWhen, personas)", () => {
    for (const f of Object.values(FLOWS)) expect(validateFlow(f)).toEqual({ ok: true, flow: f });
  });
  it("defaults completion and doneWhen for a flow drafted without them", () => {
    const { completion: _c, doneWhen: _d, ...draft } = buyTshirt;
    const r = validateFlow(draft);
    expect(r).toMatchObject({ ok: true, flow: { completion: [], doneWhen: expect.stringContaining("/checkout/success") } });
  });
  it("rejects bad completion events and unknown personas", () => {
    const errors = errorsOf({ ...buyTshirt, completion: [{ where: {} }, { event: "x", where: { a: {} } }], personas: ["nobody"] });
    expect(errors).toContain("completion[0] needs an event name");
    expect(errors).toContain("completion[1].where.a must be a string, number, boolean or a list of them");
    expect(errors).toContain('unknown persona "nobody"');
  });
  it("fills in completion and doneWhen on flows stored before they existed", async () => {
    const store = new MemoryStore();
    const { completion: _c, doneWhen: _d, ...old } = { ...buyTshirt, id: "old" };
    await store.putJson("flows/old.json", old);
    expect(await getFlow(store, "old")).toMatchObject({ id: "old", completion: [], doneWhen: expect.any(String) });
  });
  it("rejects a bad id", () => {
    expect(errorsOf({ ...buyTshirt, id: "Bad Id" })).toContain("id must be a lowercase slug (a-z, 0-9, -)");
  });
  it("rejects a non-http startUrl", () => {
    expect(errorsOf({ ...buyTshirt, startUrl: "ftp://x" })).toContain("startUrl must be an http(s) URL");
  });
  it("needs a success condition", () => {
    expect(errorsOf({ ...buyTshirt, success: {} })).toContain("success needs urlPattern or visibleText");
  });
  it("rejects duplicate step names and routes", () => {
    const steps = [...buyTshirt.steps, { route: "/other", name: "Home" }];
    expect(errorsOf({ ...buyTshirt, steps })).toContain("step names must be unique");
    const steps2 = [...buyTshirt.steps, { route: "/", name: "Again" }];
    expect(errorsOf({ ...buyTshirt, steps: steps2 })).toContain("step routes must be unique");
  });
  it("rejects unknown required steps and fields", () => {
    const required = { steps: ["Nope"], fields: ["shoeSize"] };
    const errors = errorsOf({ ...buyTshirt, required });
    expect(errors).toContain('required step "Nope" is not in steps');
    expect(errors).toContain('unknown required field "shoeSize"');
  });
});

describe("flowHash", () => {
  it("ignores key order and tracks content", () => {
    const reordered = Object.fromEntries(Object.entries(buyTshirt).reverse()) as Flow;
    expect(flowHash(reordered)).toBe(flowHash(buyTshirt));
    const renamed: Flow = { ...buyTshirt, steps: buyTshirt.steps.map((s, i) => (i ? s : { ...s, name: "Landing" })) };
    expect(flowHash(renamed)).not.toBe(flowHash(buyTshirt));
  });
});

describe("flow store", () => {
  it("overlays stored flows onto seeds", async () => {
    const store = new MemoryStore();
    const seeds = Object.values(FLOWS).sort((a, b) => a.id.localeCompare(b.id));
    expect(await listFlows(store)).toEqual(seeds);
    const edited = { ...buyTshirt, goal: "Edited" };
    const coupon = { ...buyTshirt, id: "coupon" };
    await putFlow(store, edited);
    await putFlow(store, coupon);
    await store.putText("flows/broken.json", "{nope");
    expect(await listFlows(store)).toEqual([...seeds.filter((f) => f.id !== "buy-tshirt"), edited, coupon].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await getFlow(store, "buy-tshirt")).toEqual(edited);
    expect(await getFlow(new MemoryStore(), "buy-tshirt")).toEqual(buyTshirt);
    expect(await getFlow(store, "missing")).toBeUndefined();
  });
});

describe("flow id guards", () => {
  it("does not resolve Object.prototype members as flows", async () => {
    expect(await getFlow(new MemoryStore(), "constructor")).toBeUndefined();
    expect(await getFlow(new MemoryStore(), "toString")).toBeUndefined();
  });
  it("rejects non-slug ids", async () => {
    const store = new MemoryStore();
    expect(await getFlow(store, "../x")).toBeUndefined();
    await expect(putFlow(store, { ...buyTshirt, id: "../x" })).rejects.toThrow('Invalid flow id "../x"');
  });
});

describe("diffFlows", () => {
  it("describes added steps and changed success text", () => {
    const after: Flow = {
      ...buyTshirt,
      success: { ...buyTshirt.success, visibleText: "Thanks!" },
      steps: [...buyTshirt.steps, { route: "/cart/coupon", name: "Coupon" }],
    };
    const lines = diffFlows(buyTshirt, after);
    expect(lines).toContain("steps: + /cart/coupon → Coupon");
    expect(lines).toContain('success.visibleText: "Payment confirmed" → "Thanks!"');
    expect(diffFlows(buyTshirt, buyTshirt)).toEqual([]);
  });
});
