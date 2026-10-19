/**
 * Claude usage cache must not freeze after a failed read.
 *
 * Before the fix a soft failure left the in-flight { promise } entry in the
 * cache, so every later non-forced read got that same failure back without a
 * new request until the access token rotated. The quota guard polls through
 * this cache, so one transient 429 blinded it for hours.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const fetcher = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetcher.fetch }));

const usageResponse = (utilization) => ({ ok: true, json: async () => ({ five_hour: { utilization } }) });
const remaining = (usage) => usage.quotas["session (5h)"].remaining;

afterEach(() => {
  vi.useRealTimers();
  fetcher.fetch.mockReset();
});

describe("Claude usage cache recovery", () => {
  it("retries after a failure instead of serving it until the token rotates", async () => {
    vi.useFakeTimers();
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    const token = "cache-recovery-retry";

    fetcher.fetch.mockResolvedValueOnce(usageResponse(10));
    expect(remaining(await getClaudeUsage(token))).toBe(90);

    vi.advanceTimersByTime(300001);
    fetcher.fetch.mockRejectedValue(new Error("rate limited"));
    expect((await getClaudeUsage(token)).stale).toBe(true);

    // Inside the retry window: last good reading, still flagged stale, no new call.
    const callsAfterFailure = fetcher.fetch.mock.calls.length;
    const cached = await getClaudeUsage(token);
    expect(cached.stale).toBe(true);
    expect(remaining(cached)).toBe(90);
    expect(fetcher.fetch.mock.calls.length).toBe(callsAfterFailure);

    // After the retry window a fresh read happens and recovers.
    vi.advanceTimersByTime(60001);
    fetcher.fetch.mockReset();
    fetcher.fetch.mockResolvedValueOnce(usageResponse(70));
    const recovered = await getClaudeUsage(token);
    expect(recovered.stale).toBeUndefined();
    expect(remaining(recovered)).toBe(30);
  });

  it("keeps the last good reading when a forced read fails", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    const token = "cache-recovery-forced";

    fetcher.fetch.mockResolvedValueOnce(usageResponse(40));
    expect(remaining(await getClaudeUsage(token))).toBe(60);

    fetcher.fetch.mockRejectedValue(new Error("rate limited"));
    const forced = await getClaudeUsage(token, null, { force: true });
    expect(forced.quotas).toBeUndefined();

    const next = await getClaudeUsage(token);
    expect(next.stale).toBe(true);
    expect(remaining(next)).toBe(60);
  });

  it("does not cache a failure when there is no previous reading", async () => {
    const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");
    const token = "cache-recovery-cold";

    fetcher.fetch.mockRejectedValue(new Error("offline"));
    expect((await getClaudeUsage(token)).quotas).toBeUndefined();

    fetcher.fetch.mockReset();
    fetcher.fetch.mockResolvedValueOnce(usageResponse(5));
    expect(remaining(await getClaudeUsage(token))).toBe(95);
  });
});
