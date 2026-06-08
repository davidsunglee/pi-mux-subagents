import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnCodexUnsupportedFeatures } from "../../src/index.ts";

describe("warnCodexUnsupportedFeatures", () => {
  let captured: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
  });
  afterEach(() => {
    (process.stderr as any).write = origWrite;
  });

  it("warns once for skills and once for tools on the Codex path", () => {
    warnCodexUnsupportedFeatures("worker", "research", "read,bash");
    const lines = captured.split("\n").filter(Boolean);
    assert.equal(lines.length, 2, `expected exactly two warnings; got: ${JSON.stringify(captured)}`);
    assert.ok(
      captured.includes("ignoring skills=research"),
      `expected skills warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("ignoring tools=read,bash"),
      `expected tools warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("Codex path"),
      `expected "Codex path" phrasing; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("worker"),
      `expected subagent name in warning; got: ${JSON.stringify(captured)}`,
    );
  });

  it("notes the internal subagent_done MCP tool stays available in the tools warning", () => {
    warnCodexUnsupportedFeatures("worker", undefined, "read");
    assert.ok(
      captured.includes("subagent_done"),
      `expected the MCP-tool exception note; got: ${JSON.stringify(captured)}`,
    );
  });

  it("is a no-op when both skills and tools are undefined", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined);
    assert.equal(captured, "");
  });

  it("is a no-op for empty or whitespace-only values", () => {
    warnCodexUnsupportedFeatures("worker", "", "   ", undefined);
    assert.equal(captured, "");
  });

  it("warns that system-prompt: replace is not exactly representable and is delivered additively on Codex", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined, "replace");
    assert.ok(
      /replace/i.test(captured),
      `expected the replace warning to mention the mode; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      /not.*representable|additiv/i.test(captured),
      `expected the warning to say replacement is not representable / delivered additively; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("worker"),
      `expected the subagent name in the warning; got: ${JSON.stringify(captured)}`,
    );
  });

  it("does NOT emit the replace warning for system-prompt: append (append is naturally additive)", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined, "append");
    assert.equal(captured, "", "append needs no warning — it is already additive");
  });

  it("does NOT emit the replace warning when no system-prompt mode is set", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined, undefined);
    assert.equal(captured, "");
  });
});
