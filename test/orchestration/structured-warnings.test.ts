import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../src/orchestration/run-serial.ts";
import { runParallel } from "../../src/orchestration/run-parallel.ts";
import { toPublicResults } from "../../src/tools/tool-handlers.ts";
import { warnCodexUnsupportedFeatures } from "../../src/index.ts";
import { emitDiagnostic } from "../../src/diagnostics/diagnostics.ts";
import type { LauncherDeps } from "../../src/orchestration/types.ts";

function makeDeps(): LauncherDeps {
  return {
    async launch(task, _focus, _signal, diagnostics) {
      // Real producer: structured + human into the threaded collector.
      // runSerial/runParallel normalize `name` before calling launch, so it is defined here.
      warnCodexUnsupportedFeatures(task.name!, "research", "read,bash", undefined, diagnostics);
      // Human-only diagnostic must never reach details.warnings.
      emitDiagnostic({ code: "invalid-subagent-mode", audience: { human: true }, message: "human-only line\n" }, diagnostics);
      return { id: "h-" + task.name, name: task.name!, startTime: Date.now() };
    },
    async waitForCompletion(handle) {
      return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
    },
  };
}

function makeBlockingDeps(): LauncherDeps {
  return {
    async launch(task, _focus, _signal, diagnostics) {
      // Emit a launch warning, then the task blocks on a ping.
      warnCodexUnsupportedFeatures(task.name!, "research", "read,bash", undefined, diagnostics);
      return { id: "h-" + task.name, name: task.name!, startTime: Date.now(), sessionKey: "sk-" + task.name };
    },
    async waitForCompletion(handle) {
      return {
        name: handle.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 1,
        sessionKey: "sk-" + handle.name,
        ping: { name: handle.name, message: "needs input" },
      };
    },
  };
}

function withStderr(fn: () => Promise<void>): Promise<void> {
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  return fn().finally(() => { (process.stderr as any).write = orig; });
}

describe("structured warnings surface per task and exclude human-only", () => {
  it("serial: details.results[i].warnings carries the codex skills+tools warnings only", async () => {
    await withStderr(async () => {
      const out = await runSerial([{ agent: "x", task: "t", name: "worker" }], {}, makeDeps());
      const pub = toPublicResults(out.results);
      assert.ok(pub[0].warnings?.some((w) => w.includes("skills ignored: research (Codex doesn't support skill allowlists yet)")));
      assert.ok(pub[0].warnings?.some((w) => w.includes("tools ignored: read,bash (Codex doesn't support tool allowlists yet)")));
      assert.ok(!pub[0].warnings?.some((w) => w.includes("human-only line")));
      assert.ok(pub[0].warnings?.every((w) => w.endsWith("\n")), "collector preserves the exact producer message byte-for-byte, trailing newline intact");
    });
  });

  it("parallel: warnings are attached per input-indexed task", async () => {
    await withStderr(async () => {
      const out = await runParallel(
        [{ agent: "x", task: "t", name: "a" }, { agent: "x", task: "t", name: "b" }],
        { maxConcurrency: 2 },
        makeDeps(),
      );
      const pub = toPublicResults(out.results);
      for (const r of pub) {
        assert.ok(r.warnings?.some((w) => w.includes("skills ignored: research")));
        assert.ok(!r.warnings?.some((w) => w.includes("human-only line")));
      }
    });
  });

  it("serial: blocked task's onBlocked partial preserves collected warnings", async () => {
    await withStderr(async () => {
      let blocked: { partial: { warnings?: string[] } } | undefined;
      const out = await runSerial(
        [{ agent: "x", task: "t", name: "worker" }],
        {
          onBlocked: (_i, payload) => {
            blocked = payload;
          },
        },
        makeBlockingDeps(),
      );
      assert.equal(out.blocked, true);
      assert.ok(blocked, "onBlocked should have fired");
      assert.ok(
        blocked!.partial.warnings?.some((w) => w.includes("skills ignored: research")),
        "blocked partial must carry the launch warning so it survives resume",
      );
    });
  });

  it("parallel: blocked task's onBlocked partial preserves collected warnings", async () => {
    await withStderr(async () => {
      let blocked: { partial: { warnings?: string[] } } | undefined;
      await runParallel(
        [{ agent: "x", task: "t", name: "a" }],
        {
          maxConcurrency: 1,
          onBlocked: (_i, payload) => {
            blocked = payload;
          },
        },
        makeBlockingDeps(),
      );
      assert.ok(blocked, "onBlocked should have fired");
      assert.ok(
        blocked!.partial.warnings?.some((w) => w.includes("skills ignored: research")),
        "blocked partial must carry the launch warning so it survives resume",
      );
    });
  });
});
