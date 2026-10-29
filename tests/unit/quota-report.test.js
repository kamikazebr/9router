/**
 * GET /v1/quota: what an API-key holder may see about account quotas.
 *
 * The report must stay read-only (no forced provider read, no OAuth refresh),
 * cached across callers, free of emails/tokens/provider error text, and scoped
 * to the providers a restricted key can reach.
 */

import { describe, expect, it, vi } from "vitest";
import {
  allowedProvidersForKey, buildQuotaReport, filterReportForProviders, getQuotaReport, maskEmail, QUOTA_REPORT_TTL_MS,
} from "../../src/shared/services/quotaReport.js";

// Route wiring (GET /v1/quota) only.
const calls = vi.hoisted(() => ({ usage: [] }));
vi.mock("@/lib/db/repos/connectionsRepo.js", () => ({ getProviderConnections: async () => [{
  id: "c1", provider: "claude", authType: "oauth", name: "Owner A", accessToken: "secret",
}] }));
vi.mock("@/shared/services/providerUsage.js", () => ({
  getConnectionUsage: async (connection, options) => { calls.usage.push(options); return { connection, usage: { quotas: {} } }; },
}));
vi.mock("@/sse/services/keyAccess.js", () => ({ getKeyAccessContext: async () => null }));
vi.mock("@/sse/services/model.js", () => ({ getComboModels: async () => null, getModelInfo: async () => null }));

const claude = (over = {}) => ({
  id: "c1", provider: "claude", authType: "oauth", name: "felipe@example.com", isActive: true,
  accessToken: "sk-ant-oat-secret", refreshToken: "refresh-secret",
  quotaGuard: { enabled: true, thresholdPercent: 20 },
  quotaGuardState: { paused: false, pausedModels: ["opus"], override: false },
  ...over,
});

const claudeUsage = {
  quotas: {
    "session (5h)": { used: 40, remaining: 60, remainingPercentage: 60, resetAt: "2026-10-28T18:00:00Z" },
    "weekly (7d)": { used: 70, remaining: 30, remainingPercentage: 30, resetAt: "2026-10-30T14:00:00Z" },
    "weekly opus (7d)": { used: 85, remaining: 15, remainingPercentage: 15, resetAt: "2026-10-30T14:00:00Z" },
  },
};

const depsWith = (connections, fetchUsage) => ({
  loadConnections: async () => connections,
  apikeyProviders: ["glm"],
  fetchUsage: vi.fn(fetchUsage),
});

describe("quota report", () => {
  it("lists every window with used/remaining, the model family and guard state", async () => {
    const result = await buildQuotaReport(depsWith([claude()], async () => claudeUsage));
    const [account] = result.accounts;
    expect(account).toMatchObject({
      id: "c1", provider: "claude", name: "fe***@example.com", active: true,
      guard: { enabled: true, thresholdPercent: 20, paused: false, pausedModels: ["opus"], override: false },
    });
    expect(account.windows).toEqual([
      { name: "session (5h)", model: null, usedPercent: 40, remainingPercent: 60, resetAt: "2026-10-28T18:00:00.000Z" },
      { name: "weekly (7d)", model: null, usedPercent: 70, remainingPercent: 30, resetAt: "2026-10-30T14:00:00.000Z" },
      { name: "weekly opus (7d)", model: "opus", usedPercent: 85, remainingPercent: 15, resetAt: "2026-10-30T14:00:00.000Z" },
    ]);
  });

  it("never returns credentials, emails or provider error text", async () => {
    const result = await buildQuotaReport(depsWith(
      [claude(), claude({ id: "c2", name: null, email: "other@example.com" })],
      async (c) => { if (c.id === "c2") throw new Error("401 for token sk-ant-oat-secret at https://x"); return claudeUsage; },
    ));
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/secret|felipe@|other@|https:/);
    expect(result.accounts[1]).toMatchObject({ name: "ot***@example.com", error: "Quota unavailable right now", windows: [] });
  });

  it("skips accounts whose provider reports no usage", async () => {
    const result = await buildQuotaReport(depsWith([
      claude(),
      { id: "k1", provider: "openai", authType: "apikey", apiKey: "sk-x" },
      { id: "k2", provider: "glm", authType: "apikey", apiKey: "glm-x" },
    ], async () => ({ quotas: {} })));
    expect(result.accounts.map((a) => a.id)).toEqual(["c1", "k2"]);
    expect(result.accounts[1].error).toBe("Quota not reported by the provider");
  });

  it("marks a reading served from the last good value as stale", async () => {
    const result = await buildQuotaReport(depsWith([claude()], async () => ({ ...claudeUsage, stale: true })));
    expect(result.accounts[0].stale).toBe(true);
  });

  it("falls back to the quota guard's last reading when the live read fails", async () => {
    const connection = claude({ quotaGuardState: { paused: true, checkedAt: "2026-10-28T12:00:00.000Z",
      windows: { "session (5h)": { remainingPercent: 5, resetAt: "2026-10-28T18:00:00.000Z" } },
      modelWindows: { "weekly fable (7d)": { remainingPercent: 40, resetAt: null, family: "fable" } } } });
    const result = await buildQuotaReport(depsWith([connection], async () => { throw new Error("429"); }));
    expect(result.accounts[0]).toMatchObject({ stale: true, checkedAt: "2026-10-28T12:00:00.000Z", windows: [
      { name: "session (5h)", model: null, usedPercent: 95, remainingPercent: 5, resetAt: "2026-10-28T18:00:00.000Z" },
      { name: "weekly fable (7d)", model: "fable", usedPercent: 60, remainingPercent: 40, resetAt: null },
    ] });
    expect(result.accounts[0].error).toBeUndefined();
  });

  it("reads the providers at most once per TTL for all callers", async () => {
    let now = 1_000;
    const deps = { ...depsWith([claude()], async () => claudeUsage), now: () => now };
    const state = { result: null, expiresAt: 0, promise: null };
    await Promise.all([getQuotaReport(deps, state), getQuotaReport(deps, state)]);
    now += QUOTA_REPORT_TTL_MS - 1;
    await getQuotaReport(deps, state);
    expect(deps.fetchUsage).toHaveBeenCalledTimes(1);
    now += 2;
    await getQuotaReport(deps, state);
    expect(deps.fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("masks emails inside account names", () => {
    expect(maskEmail("JB (jb@haven.hn)")).toBe("JB (jb***@haven.hn)");
    expect(maskEmail("Owner A")).toBe("Owner A");
  });
});

describe("restricted keys", () => {
  const routing = {
    getComboModels: async (name) => ({ main: ["cc/claude-opus-5-5", "nested"], nested: ["cx/gpt-5"] })[name] || null,
    getModelInfo: async (entry) => {
      const [alias] = entry.split("/");
      return { provider: { cc: "claude", cx: "codex" }[alias] || null, model: entry };
    },
    resolveProviderId: (id) => id,
  };

  it("reach the providers behind their combos and models", async () => {
    expect(await allowedProvidersForKey(["main"], routing)).toEqual(new Set(["claude", "codex"]));
    expect(await allowedProvidersForKey(["cx/gpt-5"], routing)).toEqual(new Set(["codex"]));
  });

  it("see only those providers' accounts", () => {
    const report = { object: "quota", accounts: [{ provider: "claude" }, { provider: "codex" }] };
    expect(filterReportForProviders(report, new Set(["codex"])).accounts).toEqual([{ provider: "codex" }]);
    expect(filterReportForProviders(report, null)).toBe(report);
  });
});

describe("GET /v1/quota", () => {
  it("reads usage without forcing or refreshing credentials", async () => {
    const { GET } = await import("../../src/app/api/v1/quota/route.js");
    const res = await GET(new Request("http://localhost/v1/quota"));
    expect(res.status).toBe(200);
    expect(calls.usage).toEqual([{ force: false, refresh: false }]);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret/);
  });
});
