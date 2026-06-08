import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLaunchSpec,
  warnGuardedPolicyUnsupported,
} from "../../src/launch/launch-spec.ts";
import { createDiagnosticCollector } from "../../src/diagnostics/diagnostics.ts";

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
      const collector = createDiagnosticCollector();
      warnGuardedPolicyUnsupported(
        { effectiveCli: "codex", effectiveExecutionPolicy: "guarded", executionPolicySource: "params", name: "test" },
        { collector },
      );
      assert.equal(collector.drain().length, 0, "codex should not trigger guarded-unsupported warning");
    });

    it("warns when effectiveCli is pi with guarded policy", () => {
      const collector = createDiagnosticCollector();
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = () => true; // suppress the human-channel stderr line
      try {
        warnGuardedPolicyUnsupported(
          { effectiveCli: "pi", effectiveExecutionPolicy: "guarded", executionPolicySource: "params", name: "test" },
          { collector },
        );
      } finally {
        (process.stderr as any).write = orig;
      }
      assert.equal(collector.drain().length, 1, "pi should trigger guarded-unsupported warning");
    });

    it("does not warn when policy is default (not explicit)", () => {
      const collector = createDiagnosticCollector();
      warnGuardedPolicyUnsupported(
        { effectiveCli: "pi", effectiveExecutionPolicy: "guarded", executionPolicySource: "default", name: "test" },
        { collector },
      );
      assert.equal(collector.drain().length, 0, "default policy should not warn");
    });
  });
});
