/**
 * Claude per-model weekly budgets and windows that stop being reported.
 *
 * Claude reports "weekly fable (7d)"-style budgets next to the account-wide
 * session and weekly windows. A drained model budget must pause only that model
 * family. And Claude can omit an idle 5h session window: once its last reset
 * time has passed it counts as reset, or a paused account would never resume.
 */

import { describe, expect, it, vi } from "vitest";
import {
  evaluateQuotaGuard, isQuotaGuardModelPaused, modelMatchesFamily, resumeQuotaGuard,
} from "../../src/shared/services/quotaGuard.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const quota = (remaining, resetAt = "2026-10-22T13:00:00Z") => ({ used: 100 - remaining, total: 100, remaining, remainingPercentage: remaining, resetAt });
const guarded = (state = {}) => ({ id: "c", provider: "claude", quotaGuard: { enabled: true, thresholdPercent: 20 }, quotaGuardState: state });

describe("Claude per-model weekly windows", () => {
  // Mirrors a real reading: account windows healthy, Fable weekly at 90% used.
  const usage = { quotas: { "session (5h)": quota(92), "weekly (7d)": quota(30), "weekly fable (7d)": quota(10) } };

  it("pauses only the drained model family, not the account", () => {
    const state = evaluateQuotaGuard(guarded(), usage, NOW);
    expect(state.paused).toBe(false);
    expect(state.pausedModels).toEqual(["fable"]);
    const connection = guarded(state);
    expect(isQuotaGuardModelPaused(connection, "claude-fable-5-1")).toBe(true);
    expect(isQuotaGuardModelPaused(connection, "claude-opus-5-5")).toBe(false);
    expect(isQuotaGuardModelPaused(connection, "claude-sonnet-5")).toBe(false);
  });

  it("does not pause anything while the model budget is above the threshold", () => {
    const state = evaluateQuotaGuard(guarded(), { quotas: { ...usage.quotas, "weekly fable (7d)": quota(60) } }, NOW);
    expect(state.pausedModels).toEqual([]);
  });

  it("a manual resume overrides the model pause until that window resets", () => {
    const paused = evaluateQuotaGuard(guarded(), usage, NOW);
    const resumed = resumeQuotaGuard(paused, NOW);
    expect(resumed.pausedModels).toEqual([]);

    const later = evaluateQuotaGuard(guarded(resumed), usage, NOW + 60_000);
    expect(later.override).toBe(true);
    expect(later.pausedModels).toEqual([]);

    // The window reset (new resetAt) and the budget is low again: the override ends.
    const afterReset = { quotas: { ...usage.quotas, "weekly fable (7d)": quota(10, "2026-10-29T13:00:00Z") } };
    const next = evaluateQuotaGuard(guarded(later), afterReset, Date.parse("2026-10-22T14:00:00Z"));
    expect(next.override).toBe(false);
    expect(next.pausedModels).toEqual(["fable"]);
  });

  it("matches model ids by family token only", () => {
    expect(modelMatchesFamily("cc/claude-opus-5-5", "opus")).toBe(true);
    expect(modelMatchesFamily("claude-sonnet-5", "opus")).toBe(false);
    expect(modelMatchesFamily("claude-opus-5", "oauth_apps")).toBe(false);
  });
});

describe("windows that stop being reported", () => {
  const pausedOnSession = {
    paused: true,
    windows: { "session (5h)": { remainingPercent: 5, resetAt: "2026-10-19T11:00:00Z" }, "weekly (7d)": { remainingPercent: 60, resetAt: "2026-10-22T13:00:00Z" } },
  };

  it("resumes when the 5h window disappears after its reset time", () => {
    const state = evaluateQuotaGuard(guarded(pausedOnSession), { quotas: { "weekly (7d)": quota(60) } }, NOW);
    expect(state.paused).toBe(false);
    expect(state.error).toBeUndefined();
  });

  it("stays paused when the 5h window disappears before its reset time", () => {
    const early = Date.parse("2026-10-19T10:00:00Z");
    const state = evaluateQuotaGuard(guarded(pausedOnSession), { quotas: { "weekly (7d)": quota(60) } }, early);
    expect(state.paused).toBe(true);
  });
});

describe("routing with a model-paused account", () => {
  it("skips the account only for the paused model family", async () => {
    vi.resetModules();
    const db = { getProviderConnections: vi.fn(), getSettings: async () => ({}), updateProviderConnection: vi.fn() };
    vi.doMock("@/lib/localDb", () => db);
    vi.doMock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}), pickProxyPoolId: vi.fn() }));
    vi.doMock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
    vi.doMock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    const fablePaused = { id: "owner", isActive: true, quotaGuard: { enabled: true }, quotaGuardState: { paused: false, pausedModels: ["fable"] } };
    db.getProviderConnections.mockResolvedValue([fablePaused]);

    expect(await getProviderCredentials("claude", null, "claude-opus-5-5")).toMatchObject({ connectionId: "owner" });
    expect(await getProviderCredentials("claude", null, "claude-fable-5-1")).toMatchObject({ allQuotaPaused: true });
  });
});
