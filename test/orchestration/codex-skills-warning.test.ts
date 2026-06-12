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

  it("warns once for skills and once for tools with shortened Codex messages", () => {
    warnCodexUnsupportedFeatures("worker", "research", "read,bash");
    assert.deepEqual(captured.split("\n").filter(Boolean), [
      "[subagents] worker: skills ignored: research (Codex doesn't support skill allowlists yet)",
      "[subagents] worker: tools ignored: read,bash (Codex doesn't support tool allowlists yet)",
    ]);
  });

  it("keeps the tools warning focused on the unsupported allowlist", () => {
    warnCodexUnsupportedFeatures("worker", undefined, "read");
    assert.equal(
      captured,
      "[subagents] worker: tools ignored: read (Codex doesn't support tool allowlists yet)\n",
    );
    assert.equal(captured.includes("subagent_done"), false);
  });

  it("is a no-op when both skills and tools are undefined", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined);
    assert.equal(captured, "");
  });

  it("is a no-op for empty or whitespace-only values", () => {
    warnCodexUnsupportedFeatures("worker", "", "   ", undefined);
    assert.equal(captured, "");
  });

  it("warns that system-prompt=replace is appended to the Codex task", () => {
    warnCodexUnsupportedFeatures("worker", undefined, undefined, "replace");
    assert.equal(
      captured,
      "[subagents] worker: system-prompt=replace unsupported by Codex; identity was appended to the task\n",
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
