/**
 * Only the quota guard may write quotaGuardState, and guard config only enters
 * through the validated settings route. Import/create paths spread caller data
 * into the stored row, which let them plant an unvalidated pause (e.g. a
 * permanent pause on an account whose usage cannot be read).
 */

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
  directory = mkdtempSync(join(tmpdir(), "9router-quota-guard-fields-"));
  holder.db = await createSqlJsAdapter(join(directory, "db.sqlite"));
  holder.db.run(`CREATE TABLE providerConnections (${Object.entries(TABLES.providerConnections.columns).map(([name, type]) => `${name} ${type}`).join(", ")})`);
});
afterAll(() => { holder.db?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

const planted = { paused: true, override: false, windows: {} };

describe("quota guard field ownership", () => {
  it("a new connection cannot be created with guard config or state", async () => {
    const c = await repo.createProviderConnection({
      provider: "codex", authType: "apikey", name: "fresh",
      quotaGuard: { enabled: true, thresholdPercent: 99 }, quotaGuardState: planted,
    });
    const stored = await repo.getProviderConnectionById(c.id);
    expect(stored.quotaGuard).toBeUndefined();
    expect(stored.quotaGuardState).toBeUndefined();
  });

  it("re-importing an existing connection keeps its guard config and state", async () => {
    const c = await repo.createProviderConnection({ provider: "codex", authType: "apikey", name: "existing" });
    const configured = await repo.updateProviderConnection(c.id, { quotaGuard: { enabled: true, thresholdPercent: 20 } });
    await repo.updateProviderQuotaGuardState(configured, { paused: false, windows: {} });

    await repo.createProviderConnection({
      provider: "codex", authType: "apikey", name: "existing",
      quotaGuard: { enabled: false }, quotaGuardState: planted,
    });
    const stored = await repo.getProviderConnectionById(c.id);
    expect(stored.quotaGuard).toEqual({ enabled: true, thresholdPercent: 20 });
    expect(stored.quotaGuardState.paused).toBe(false);
  });

  it("a generic update cannot write guard state directly", async () => {
    const c = await repo.createProviderConnection({ provider: "codex", authType: "apikey", name: "update" });
    await repo.updateProviderConnection(c.id, { quotaGuardState: planted });
    const stored = await repo.getProviderConnectionById(c.id);
    expect(stored.quotaGuardState?.paused).not.toBe(true);
  });
});
