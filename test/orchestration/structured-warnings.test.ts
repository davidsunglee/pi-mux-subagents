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
      assert.ok(pub[0].warnings?.some((w) => w.includes("ignoring skills=research on Codex path")));
      assert.ok(pub[0].warnings?.some((w) => w.includes("ignoring tools=read,bash on Codex path")));
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
        assert.ok(r.warnings?.some((w) => w.includes("ignoring skills=research")));
        assert.ok(!r.warnings?.some((w) => w.includes("human-only line")));
      }
    });
  });
});
