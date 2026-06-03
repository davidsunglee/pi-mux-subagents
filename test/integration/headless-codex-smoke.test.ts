import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../src/backends/headless.ts";
import { buildCodexExecArgs } from "../../src/backends/codex-stream.ts";
import { buildCodexMcpOverrideArgs } from "../../src/backends/codex-mcp.ts";
import { SLOW_LANE_OPT_IN, getTestModel } from "./harness.ts";

const CODEX_AVAILABLE = (() => {
  try {
    execSync("which codex", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

// Real-CLI smoke: validates that the resume argv shape produced by
// buildCodexExecArgs and the MCP overrides from buildCodexMcpOverrideArgs are
// accepted by the installed Codex CLI's parser / config loader. These cases
// invoke the real `codex` binary (one even runs a model turn), so they are gated
// on the slow lane — this file is matched by test:integration's glob, and we must
// not shell out to Codex (time/network/auth) during normal integration runs.
// Deterministically no-ops when codex is absent or PI_RUN_SLOW is unset.
describe("headless-codex resume argv parses against real CLI", { skip: !CODEX_AVAILABLE || !SLOW_LANE_OPT_IN, timeout: 30_000 }, () => {
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

    let combined: string;
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

  // Real-CLI regression for the pane completion-tool auto-approval. The generated
  // overrides MUST include a subagent_done auto-approval scoped to the
  // pi_subagent server, and the installed Codex CLI MUST recognize it. We assert
  // both via `--strict-config`, which errors ("unknown configuration field" /
  // "unknown variant") on any unrecognized key or invalid approval_mode value.
  // Without the fix the override is absent (so the pane has no way to run
  // subagent_done unattended); with a wrong key/value strict-config would reject it.
  it("generated MCP overrides auto-approve subagent_done and are accepted by the real CLI (--strict-config)", () => {
    const mcpArgs = buildCodexMcpOverrideArgs({ sentinelFile: join(tmpdir(), "codex-approval-smoke.done") });
    const joined = mcpArgs.join(" ");
    assert.ok(
      joined.includes('mcp_servers.pi_subagent.tools.subagent_done.approval_mode="approve"'),
      `generated overrides must auto-approve subagent_done; got: ${joined}`,
    );

    // Run the real CLI with the exact generated overrides under strict config.
    // A trivial prompt + workspace-write/never keeps this cheap and deterministic;
    // the point is the config-load phase, which validates the mcp_servers.*.tools
    // keys before any model turn.
    let combined: string;
    try {
      combined = execFileSync(
        "codex",
        [
          "exec", "--strict-config", "--skip-git-repo-check",
          "--sandbox", "workspace-write", "-c", 'approval_policy="never"',
          ...mcpArgs,
          "Reply with exactly: OK",
        ],
        { input: "", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
      );
    } catch (err: any) {
      combined = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`;
    }
    assert.ok(
      !/unknown configuration field/i.test(combined),
      `Codex rejected a generated MCP override field: ${combined}`,
    );
    assert.ok(
      !/unknown variant/i.test(combined),
      `Codex rejected the approval_mode value: ${combined}`,
    );
    assert.ok(
      !/error loading config\.toml/i.test(combined),
      `Codex failed to load config with generated overrides: ${combined}`,
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
