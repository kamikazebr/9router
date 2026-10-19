import { beforeEach, describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => ({ connection: null }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, options) => Response.json(body, options) } }));
vi.mock("@/models", () => ({
  getProviderConnectionById: async () => store.connection,
  getProxyPoolById: vi.fn(), deleteProviderConnection: vi.fn(),
  updateProviderConnection: async (_, patch) => (store.connection = { ...store.connection, ...patch }),
}));
const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
const request = (body) => new Request("http://localhost/api/providers/a", { method: "PUT", body: JSON.stringify(body) });
beforeEach(() => { store.connection = { id: "a", provider: "codex", authType: "oauth", accessToken: "private" }; });

describe("quota guard configuration API", () => {
  it("saves per-account settings and strips untrusted pause state", async () => {
    const res = await PUT(request({ quotaGuard: { enabled: true, thresholdPercent: 35, paused: false }, quotaGuardState: { paused: false } }), { params: { id: "a" } });
    const body = await res.json();
    expect(body.connection.quotaGuard).toEqual({ enabled: true, thresholdPercent: 35 });
    expect(body.connection.quotaGuardState).toBeUndefined();
    expect(body.connection.accessToken).toBeUndefined();
  });
  it.each([-1, 100, null, "50"])("rejects invalid threshold %s", async (thresholdPercent) => {
    const res = await PUT(request({ quotaGuard: { enabled: true, thresholdPercent } }), { params: { id: "a" } });
    expect(res.status).toBe(400);
    expect(store.connection.quotaGuard).toBeUndefined();
  });
  it("passes an explicit resume through and rejects any other value", async () => {
    const ok = await PUT(request({ isActive: true, quotaGuardResume: true }), { params: { id: "a" } });
    expect(ok.status).toBe(200);
    expect(store.connection.quotaGuardResume).toBe(true);
    for (const quotaGuardResume of [false, "true", 1]) {
      const res = await PUT(request({ quotaGuardResume }), { params: { id: "a" } });
      expect(res.status).toBe(400);
    }
  });
  it("does not enable monitoring for a provider without a usage reader", async () => {
    store.connection.provider = "unsupported";
    const res = await PUT(request({ quotaGuard: { enabled: true, thresholdPercent: 50 } }), { params: { id: "a" } });
    expect(res.status).toBe(400);
  });
});
