/**
 * Periodic quota guard checks must not rotate OAuth tokens.
 *
 * Refreshing from the unattended monitor races the request path and the
 * background refresher on the same rotating refresh token, which can revoke
 * the token family and log the account out. Only a manual check may refresh.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ connection: null, refreshCalls: 0 }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: async () => store.connection,
  updateProviderConnection: async (_, patch) => { store.connection = { ...store.connection, ...patch }; },
}));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () => ({
  needsRefresh: () => true,
  refreshCredentials: async () => { store.refreshCalls += 1; return { accessToken: "fresh", refreshToken: "rotated", expiresIn: 3600 }; },
}) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({ strictProxy: true }) }));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: async () => ({ message: "Usage API temporarily unavailable (401)" }),
}));

const { getConnectionUsage } = await import("../../src/shared/services/providerUsage.js");

const oauthConnection = (expiresAt) => ({
  id: "a", provider: "claude", authType: "oauth", accessToken: "current", refreshToken: "refresh", expiresAt,
});

beforeEach(() => { store.refreshCalls = 0; });

describe("read-only usage reads", () => {
  it("never refreshes, even when the token is due or usage reports 401", async () => {
    store.connection = oauthConnection("2099-01-01T00:00:00Z");
    const { usage } = await getConnectionUsage(store.connection, { refresh: false });
    expect(usage.message).toMatch(/401/);
    expect(store.refreshCalls).toBe(0);
    expect(store.connection.refreshToken).toBe("refresh");
  });

  it("fails fast on an expired access token instead of refreshing it", async () => {
    store.connection = oauthConnection("2000-01-01T00:00:00Z");
    await expect(getConnectionUsage(store.connection, { refresh: false })).rejects.toMatchObject({ status: 401 });
    expect(store.refreshCalls).toBe(0);
  });

  it("still refreshes on the default (dashboard) path", async () => {
    store.connection = oauthConnection("2099-01-01T00:00:00Z");
    await getConnectionUsage(store.connection);
    expect(store.refreshCalls).toBeGreaterThan(0);
  });
});
