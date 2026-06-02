import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../src/backends/headless.ts";
import { buildCodexExecArgs } from "../../src/backends/codex-stream.ts";
import { SLOW_LANE_OPT_IN, getTestModel } from "./harness.ts";

const CODEX_AVAILABLE = (() => {
  try {
    execSync("which codex", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

// Parse-only smoke: validates that the resume argv shape produced by
// buildCodexExecArgs is actually accepted by the installed Codex CLI's argument
// parser. This is cheap (no model turn), so it runs whenever codex is present —
// it does not require the slow lane. It deterministically no-ops when codex is
// absent.
describe("headless-codex resume argv parses against real CLI", { skip: !CODEX_AVAILABLE, timeout: 30_000 }, () => {
  it("codex accepts `exec [opts] resume <id> -` arg ordering", () => {
    const args = buildCodexExecArgs(
      {
        codexModelArg: undefined,
        effectiveThinking: undefined,
        effectiveExecutionPolicy: "guarded",
        resumeSessionId: "00000000-0000-0000-0000-000000000000",
      } as any,
      { outputLastMessageFile: join(tmpdir(), "codex-parse-smoke.txt"), cwd: tmpdir() },
    );
    // Sanity: exec-level flags precede the `resume` subcommand.
    const resumeIdx = args.indexOf("resume");
    assert.ok(resumeIdx > args.indexOf("--cd"), "--cd must precede resume in built argv");

    let combined = "";
    try {
      // Empty stdin + bogus session id: parsing succeeds, then Codex bails out
      // *after* the parser (e.g. "No prompt provided via stdin" / session lookup).
      combined = execFileSync("codex", args, {
        input: "",
        timeout: 20_000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (err: any) {
      combined = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`;
    }
    assert.ok(
      !/unexpected argument/i.test(combined),
      `Codex rejected the resume argv ordering: ${combined}`,
    );
    assert.ok(
      !/unexpected argument '--cd'/i.test(combined),
      `Codex rejected --cd placement: ${combined}`,
    );
  });
});

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
