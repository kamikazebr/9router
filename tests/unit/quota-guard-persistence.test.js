import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import { TABLES } from "../../src/lib/db/schema.js";

const holder = vi.hoisted(() => ({ db: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => holder.db }));
const repo = await import("../../src/lib/db/repos/connectionsRepo.js");
let directory;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "9router-quota-guard-"));
  holder.db = await createSqlJsAdapter(join(directory, "db.sqlite"));
  holder.db.run(`CREATE TABLE providerConnections (${Object.entries(TABLES.providerConnections.columns).map(([name, type]) => `${name} ${type}`).join(", ")})`);
});
afterAll(() => { holder.db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function create(name) {
  const c = await repo.createProviderConnection({ provider: "codex", authType: "apikey", name });
  const configured = await repo.updateProviderConnection(c.id, { quotaGuard: { enabled: true, thresholdPercent: 50 } });
  return repo.updateProviderQuotaGuardState(configured,
    { paused: true, windows: { session: { remainingPercent: 40, resetAt: "2026-10-16T12:00:00Z" } } });
}

describe("quota guard persistence", () => {
  it("an explicit resume overrides an automatic pause without removing provider locks", async () => {
    const c = await create("resume");
    await repo.updateProviderConnection(c.id, { modelLock_test: "2099-01-01T00:00:00Z" });
    const resumed = await repo.updateProviderConnection(c.id, { isActive: true, quotaGuardResume: true });
    expect(resumed.quotaGuardState.paused).toBe(false);
    expect(resumed.quotaGuardState.override).toBe(true);
    expect(resumed.modelLock_test).toBe("2099-01-01T00:00:00Z");
    expect(resumed.quotaGuardResume).toBeUndefined();
  });

  it("re-enabling a connection keeps its automatic pause", async () => {
    const c = await create("re-enable");
    await repo.updateProviderConnection(c.id, { isActive: false });
    const enabled = await repo.updateProviderConnection(c.id, { isActive: true });
    expect(enabled.isActive).toBe(true);
    expect(enabled.quotaGuardState.paused).toBe(true);
    expect(enabled.quotaGuardState.override).not.toBe(true);
  });

  it("rejects an obsolete monitor write after manual disable or resume", async () => {
    expect(repo.updateProviderQuotaGuardState).toBeTypeOf("function");
    const c = await create("race");
    await repo.updateProviderConnection(c.id, { isActive: false });
    expect(await repo.updateProviderQuotaGuardState(c, { paused: false })).toBeNull();
    const disabled = await repo.getProviderConnectionById(c.id);
    expect(disabled.isActive).toBe(false);
    await repo.updateProviderConnection(c.id, { isActive: true, quotaGuardResume: true });
    expect(await repo.updateProviderQuotaGuardState(c, { paused: true })).toBeNull();
    expect((await repo.getProviderConnectionById(c.id)).quotaGuardState.override).toBe(true);
  });

  it("merges guard state without losing credentials refreshed during a check", async () => {
    const c = await create("token-race");
    await repo.updateProviderConnection(c.id, { accessToken: "rotated-token" });
    const next = await repo.updateProviderQuotaGuardState(c, { paused: false });
    expect(next.accessToken).toBe("rotated-token");
    expect(next.quotaGuardState.paused).toBe(false);
  });

  it("disabling the guard clears only its automatic pause", async () => {
    const c = await create("disable-guard");
    await repo.updateProviderConnection(c.id, { isActive: false });
    const next = await repo.updateProviderConnection(c.id, { quotaGuard: { enabled: false, thresholdPercent: 50 } });
    expect(next.isActive).toBe(false);
    expect(next.quotaGuardState.paused).toBe(false);
  });
});
