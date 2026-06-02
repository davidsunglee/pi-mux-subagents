import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLaunchSpec,
  warnGuardedPolicyUnsupported,
} from "../../src/launch/launch-spec.ts";

describe("codex-launch-spec", () => {
  describe("codexModelArg", () => {
    it("strips provider prefix from model", () => {
      const spec = resolveLaunchSpec(
        { name: "test", task: "t", cli: "codex", model: "openai-codex/gpt-5.4-mini" },
        {
          cwd: process.cwd(),
          sessionManager: {
            getSessionId: () => "test-session",
            getSessionDir: () => "/tmp",
            getSessionFile: () => null,
          } as any,
        },
      );
      assert.equal(spec.codexModelArg, "gpt-5.4-mini");
    });

    it("passes through bare model names", () => {
      const spec = resolveLaunchSpec(
        { name: "test", task: "t", cli: "codex", model: "gpt-5.4-mini" },
        {
          cwd: process.cwd(),
          sessionManager: {
            getSessionId: () => "test-session",
            getSessionDir: () => "/tmp",
            getSessionFile: () => null,
          } as any,
        },
      );
      assert.equal(spec.codexModelArg, "gpt-5.4-mini");
    });

    it("sets effectiveCli to codex", () => {
      const spec = resolveLaunchSpec(
        { name: "test", task: "t", cli: "codex" },
        {
          cwd: process.cwd(),
          sessionManager: {
            getSessionId: () => "test-session",
            getSessionDir: () => "/tmp",
            getSessionFile: () => null,
          } as any,
        },
      );
      assert.equal(spec.effectiveCli, "codex");
    });
  });

  describe("warnGuardedPolicyUnsupported", () => {
    it("does not warn when effectiveCli is codex with guarded policy", () => {
      let writeCount = 0;
      warnGuardedPolicyUnsupported(
        {
          effectiveCli: "codex",
          effectiveExecutionPolicy: "guarded",
          executionPolicySource: "params",
          name: "test",
        },
        () => {
          writeCount++;
        },
      );
      assert.equal(writeCount, 0, "codex should not trigger guarded-unsupported warning");
    });

    it("warns when effectiveCli is pi with guarded policy", () => {
      let writeCount = 0;
      warnGuardedPolicyUnsupported(
        {
          effectiveCli: "pi",
          effectiveExecutionPolicy: "guarded",
          executionPolicySource: "params",
          name: "test",
        },
        () => {
          writeCount++;
        },
      );
      assert.equal(writeCount, 1, "pi should trigger guarded-unsupported warning");
    });

    it("does not warn when policy is default (not explicit)", () => {
      let writeCount = 0;
      warnGuardedPolicyUnsupported(
        {
          effectiveCli: "pi",
          effectiveExecutionPolicy: "guarded",
          executionPolicySource: "default",
          name: "test",
        },
        () => {
          writeCount++;
        },
      );
      assert.equal(writeCount, 0, "default policy should not warn");
    });
  });
});
