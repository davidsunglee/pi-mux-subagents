import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnClaudeSkillsDropped } from "../../src/index.ts";

describe("warnClaudeSkillsDropped", () => {
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

  it("writes the shortened single-line warning when effectiveSkills is non-empty", () => {
    warnClaudeSkillsDropped("my-subagent", "plan, code-review");
    assert.deepEqual(captured.split("\n").filter(Boolean), [
      "[subagents] my-subagent: skills ignored: plan, code-review (Claude doesn't support skill allowlists yet)",
    ]);
  });

  it("is a no-op when effectiveSkills is undefined", () => {
    warnClaudeSkillsDropped("my-subagent", undefined);
    assert.equal(captured, "");
  });

  it("is a no-op when effectiveSkills is the empty string or whitespace-only", () => {
    warnClaudeSkillsDropped("my-subagent", "");
    warnClaudeSkillsDropped("my-subagent", "   ");
    assert.equal(captured, "");
  });
});
