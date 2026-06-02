import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../src/backends/headless.ts";
import { SLOW_LANE_OPT_IN, getTestModel } from "./harness.ts";

const CODEX_AVAILABLE = (() => {
  try {
    execSync("which codex", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-codex-smoke", { skip: !CODEX_AVAILABLE || !SLOW_LANE_OPT_IN, timeout: 180_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-codex-"));
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a unique-marker Codex task, archives transcript under codex-cli/", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const marker = `HEADLESS_CODEX_SMOKE_${randomUUID()}`;
    const handle = await backend.launch(
      { task: `Reply with exactly: ${marker}`, cli: "codex", model: getTestModel("codex") },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(
      result.finalMessage.includes(marker),
      `finalMessage must include marker ${marker}; got: ${JSON.stringify(result.finalMessage)}`,
    );
    assert.ok(result.transcript && result.transcript.length > 0, "transcript must be non-empty");

    const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "codex-cli");
    assert.ok(result.transcriptPath, "transcriptPath must be set");
    assert.ok(
      result.transcriptPath!.startsWith(archiveRoot),
      `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
    );
    assert.ok(existsSync(result.transcriptPath!), "archived transcript file must exist on disk");

    assert.ok(
      typeof result.sessionId === "string" || result.sessionId === undefined,
      `sessionId must be a string or undefined, got: ${typeof result.sessionId}`,
    );
  });

  it("resume: exercises resumable or deterministic-unsupported path", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent-resume.jsonl"),
        getSessionId: () => "parent-resume",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const marker = `HEADLESS_CODEX_RESUME_${randomUUID()}`;
    const firstHandle = await backend.launch(
      { task: `Reply with exactly: ${marker}`, cli: "codex", model: getTestModel("codex") },
      false,
    );
    const firstResult = await backend.watch(firstHandle);
    assert.equal(firstResult.exitCode, 0, `initial run failed; error=${firstResult.error}`);

    if (typeof firstResult.sessionId === "string") {
      // Session id present: resume is supported, exercise the resume path
      const resumeHandle = await backend.launch(
        {
          task: "Reply with the single word DONE",
          cli: "codex",
          resumeSessionId: firstResult.sessionId,
          model: getTestModel("codex"),
        },
        false,
      );
      const resumeResult = await backend.watch(resumeHandle);
      assert.equal(resumeResult.exitCode, 0, `resume run failed; error=${resumeResult.error}`);
    } else {
      // Session id absent: exercise the deterministic unsupported path
      const resumeHandle = await backend.launch(
        {
          task: "Reply with the single word DONE",
          cli: "codex",
          resumeSessionId: "",
          model: getTestModel("codex"),
        },
        false,
      );
      const resumeResult = await backend.watch(resumeHandle);
      assert.equal(resumeResult.exitCode, 1, "expected exitCode 1 for empty resumeSessionId");
      assert.match(
        resumeResult.error ?? "",
        /codex resume requested without a session id/,
        `error must match the deterministic-unsupported message; got: ${resumeResult.error}`,
      );
    }
  });
});
