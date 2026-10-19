/**
 * Claude→Claude streaming must still decloak tool names.
 *
 * When the upstream is another 9router exposed as an Anthropic-compatible
 * provider, its SSE can carry "_ide"-cloaked tool names with no local
 * toolNameMap. A plain passthrough forwards "Bash_ide" to Claude Code, which
 * rejects it as an unknown tool, so the stream has to go through
 * translateResponse() even though source and target formats are equal.
 */

import { describe, it, expect } from "vitest";
import { needsStreamTransform } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

describe("needsStreamTransform", () => {
  it("transforms Claude→Claude streams so cloaked tool names can be restored", () => {
    expect(needsStreamTransform(FORMATS.CLAUDE, FORMATS.CLAUDE)).toBe(true);
  });

  it("keeps passthrough for other same-format streams", () => {
    expect(needsStreamTransform(FORMATS.OPENAI, FORMATS.OPENAI)).toBe(false);
  });

  it("transforms whenever the formats differ", () => {
    expect(needsStreamTransform(FORMATS.OPENAI, FORMATS.CLAUDE)).toBe(true);
  });
});

describe("Claude→Claude stream from a remote 9router", () => {
  const toolStart = (name) => ({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
  });

  it("strips the cloak suffix when no local toolNameMap exists", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, toolStart(`Bash${CLAUDE_TOOL_SUFFIX}`), { toolNameMap: null });
    expect(out.content_block.name).toBe("Bash");
  });

  it("leaves uncloaked tool names untouched", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, toolStart("Read"), { toolNameMap: null });
    expect(out.content_block.name).toBe("Read");
  });
});
