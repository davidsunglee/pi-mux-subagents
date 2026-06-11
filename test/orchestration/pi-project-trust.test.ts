// Pi-backed subagent launches must approve project trust for the single child
// run (so neither pane nor headless children stall on Pi's interactive
// project-trust prompt), and this extension's own parent-side `.pi/agents`
// discovery must be gated on `ctx.isProjectTrusted()` so untrusted repositories
// cannot bootstrap launch behavior (execution-policy, cwd, …) through agent
// frontmatter before trust is established.
//
// These are launch-time input-loading decisions and are deliberately separate
// from `executionPolicy`, which governs backend autonomy/sandboxing.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { launchSubagent, __test__ } from "../../src/index.ts";
import { loadAgentDefaults, resolveLaunchSpec } from "../../src/launch/launch-spec.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

// ── Headless Pi: --approve flag ───────────────────────────────────────────────
describe("runPiHeadless approves project trust for the child run", () => {
  let backendModule: any;
  let lastSpawn: { cmd: string; args: string[]; env?: Record<string, string> } | null = null;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;
    ee.kill = () => true;
    queueMicrotask(() => {
      ee.emit("exit", 0);
      ee.emit("close", 0);
    });
    return ee;
  }

  before(async () => {
    backendModule = await import("../../src/backends/headless.ts");
    backendModule.__test__.setSpawn(((cmd: string, args: string[], opts: any) => {
      lastSpawn = { cmd, args, env: opts?.env };
      return makeFakeProc();
    }) as any);
  });

  after(() => {
    backendModule.__test__.restoreSpawn();
  });

  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/fake.jsonl",
      getSessionId: () => "test",
      getSessionDir: () => "/tmp",
    } as any,
    cwd: "/tmp",
  };

  it("headless pi argv includes --approve so the child does not stall on the project-trust prompt", async () => {
    lastSpawn = null;
    const backend = backendModule.makeHeadlessBackend(ctx);
    const handle = await backend.launch({ name: "t", task: "hello", cli: "pi" }, false);
    await backend.watch(handle);

    assert.ok(lastSpawn, "pi should have been spawned");
    assert.equal(lastSpawn!.cmd, "pi");
    assert.ok(
      lastSpawn!.args.includes("--approve"),
      `headless pi launch must pass --approve to approve project trust for the child run; got: ${lastSpawn!.args.join(" ")}`,
    );
  });

  it("approving project trust does not write persistent trust state (no config files created in cwd)", async () => {
    const cwdDir = mkdtempSync(join(tmpdir(), "pi-approve-cwd-"));
    try {
      lastSpawn = null;
      const backend = backendModule.makeHeadlessBackend({ ...ctx, cwd: cwdDir });
      const handle = await backend.launch({ name: "t", task: "hello", cli: "pi", cwd: cwdDir }, false);
      await backend.watch(handle);

      assert.ok(lastSpawn!.args.includes("--approve"), "expected --approve to be present");
      // The flag approves trust for this run only; the extension must not
      // materialize a `.pi/trust` (or similar) persistent trust record itself.
      assert.equal(
        readdirSync(cwdDir).includes(".pi"),
        false,
        "approving project trust for the child run must not write persistent trust state into the project",
      );
    } finally {
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

// ── Pane Pi: --approve flag ───────────────────────────────────────────────────
describe("pane pi launch approves project trust for the child run", () => {
  type LaunchParams = Parameters<typeof launchSubagent>[0];
  type LaunchCtx = Parameters<typeof launchSubagent>[1];

  async function captureLaunchScript(
    subagentParams: Partial<LaunchParams> & { name: string; task: string },
  ): Promise<string> {
    const sessionDir = mkdtempSync(join(tmpdir(), "pane-trust-"));
    const ctxCwd = mkdtempSync(join(tmpdir(), "pane-trust-ctx-"));
    try {
      const params: LaunchParams = { cli: "pi", ...subagentParams };
      const ctx: LaunchCtx = {
        sessionManager: {
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => sessionDir,
        },
        cwd: ctxCwd,
      };
      await launchSubagent(params, ctx, { surface: "pi-test-fake-surface" }).catch(() => {
        /* mux-less sendCommand throws; we only need the script */
      });

      const scriptsRoot = join(sessionDir, "artifacts");
      const found: string[] = [];
      const walk = (dir: string) => {
        let names: string[];
        try { names = readdirSync(dir); } catch { return; }
        for (const n of names) {
          const p = join(dir, n);
          try {
            if (statSync(p).isDirectory()) walk(p);
            else if (n.endsWith(".sh")) found.push(p);
          } catch {}
        }
      };
      walk(scriptsRoot);
      assert.equal(found.length, 1, `expected one launch script, got ${found.join(", ")}`);
      return readFileSync(found[0], "utf8");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(ctxCwd, { recursive: true, force: true });
    }
  }

  it("pane pi command includes --approve so a pane-spawned child does not stall on the project-trust prompt", async () => {
    const script = await captureLaunchScript({ name: "pane-trust", task: "hello" });
    // The launcher shell-escapes each token, so the flag appears as '--approve'
    // on the `pi …` command line.
    assert.match(
      script,
      /\spi\s[^\n]*--approve\b/,
      `pane pi launch command must include --approve; got:\n${script}`,
    );
  });
});

// ── Pi resume-by-session: --approve flag ──────────────────────────────────────
// A resumed pane Pi child runs `pi --session <path> …`. It must receive the same
// one-run project-trust approval as the initial pane/headless Pi launches so a
// resumed follow-up never stalls on Pi's interactive project-trust prompt (and
// does not silently skip project-local resources). This writes no persistent
// trust state — it is the per-run `--approve` override.
describe("pi resume-by-session approves project trust for the resumed child run", () => {
  let scratchDir: string;
  let sessionPath: string;
  let fake: { api: any };

  function makeFakePi() {
    const tools = new Map<string, any>();
    return {
      tools,
      api: {
        registerTool(spec: any) { tools.set(spec.name, spec); },
        registerCommand() {},
        registerMessageRenderer() {},
        sendUserMessage() {},
        sendMessage() {},
        on() {},
      },
    };
  }

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "resume-trust-"));
    sessionPath = join(scratchDir, "owned.jsonl");
    writeFileSync(sessionPath, "", "utf8");

    fake = makeFakePi();
    subagentsExtension(fake.api as any);
    __test__.setMuxAvailableOverride(true);
    __test__.setSurfaceOverrides({
      createSurface: () => "test-surface",
      sendLongCommand: () => {},
    });
  });

  afterEach(() => {
    __test__.setMuxAvailableOverride(null);
    __test__.setSurfaceOverrides(null);
    __test__.setWatchSubagentOverride(null);
    __test__.resetRegistry();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("pi resume command includes --approve so a resumed child does not stall on the project-trust prompt", async () => {
    const resumeTool = (fake.api as any) && (fake as any).tools.get("subagent_resume");
    assert.ok(resumeTool, "subagent_resume must be registered");

    // Watcher returns a terminal result immediately so the fire-and-forget
    // path settles cleanly; we only care about the constructed launch command.
    __test__.setWatchSubagentOverride(async () => ({
      name: "stub", task: "stub", transcriptPath: null,
      exitCode: 0, error: undefined, ping: undefined, elapsed: 0.01, summary: "ok",
    }) as any);

    const ctx = {
      sessionManager: {
        getSessionFile: () => join(scratchDir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => scratchDir,
      },
      cwd: scratchDir,
    };
    const result = await resumeTool.execute(
      "tc-resume-approve",
      { sessionPath, name: "Resume Trust" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(result.details?.status, "started");

    const command = __test__.getLastLaunchCommand();
    assert.ok(command, "resume tool should record its last launch command");
    assert.match(
      command!,
      /\bpi\s[^\n]*--approve\b/,
      `pi resume command must include --approve; got:\n${command}`,
    );

    await new Promise((r) => setTimeout(r, 50));
  });
});

// ── Untrusted project gating of `.pi/agents` discovery ────────────────────────
describe("untrusted project-local agent frontmatter cannot bootstrap launch behavior", () => {
  it("resolveLaunchSpec ignores project-local .pi/agents when ctx.isProjectTrusted() is false", () => {
    const root = mkdtempSync(join(tmpdir(), "untrusted-agent-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "evil-agent.md"),
        "---\ncli: claude\nexecution-policy: unrestricted\ncwd: /tmp/evil\n---\nevil body\n",
        "utf8",
      );

      const untrustedCtx = { ...baseCtx, isProjectTrusted: () => false };
      const spec = resolveLaunchSpec(
        { name: "Victim", task: "do", agent: "evil-agent", cwd: root },
        untrustedCtx,
      );

      // Frontmatter must not be honored: execution policy falls back to the
      // guarded default and is sourced from the default, not the agent file.
      assert.equal(
        spec.effectiveExecutionPolicy,
        "guarded",
        "untrusted project-local agent must not bootstrap execution-policy: unrestricted",
      );
      assert.equal(spec.executionPolicySource, "default");
      // The agent's `cwd: /tmp/evil` must not take effect either.
      assert.notEqual(spec.effectiveCwd, "/tmp/evil");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveLaunchSpec honors project-local .pi/agents when ctx.isProjectTrusted() is true", () => {
    const root = mkdtempSync(join(tmpdir(), "trusted-agent-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "ok-agent.md"),
        "---\ncli: claude\nexecution-policy: unrestricted\n---\nok body\n",
        "utf8",
      );

      const trustedCtx = { ...baseCtx, isProjectTrusted: () => true };
      const spec = resolveLaunchSpec(
        { name: "Trusted", task: "do", agent: "ok-agent", cwd: root },
        trustedCtx,
      );
      assert.equal(spec.effectiveExecutionPolicy, "unrestricted");
      assert.equal(spec.executionPolicySource, "agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveLaunchSpec preserves legacy behavior when ctx.isProjectTrusted is absent (trusted by default)", () => {
    const root = mkdtempSync(join(tmpdir(), "legacy-agent-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "legacy-agent.md"),
        "---\ncli: claude\nexecution-policy: unrestricted\n---\nlegacy body\n",
        "utf8",
      );

      const spec = resolveLaunchSpec(
        { name: "Legacy", task: "do", agent: "legacy-agent", cwd: root },
        baseCtx,
      );
      assert.equal(spec.effectiveExecutionPolicy, "unrestricted");
      assert.equal(spec.executionPolicySource, "agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadAgentDefaults skips the project-local path when projectTrusted is false", () => {
    const root = mkdtempSync(join(tmpdir(), "untrusted-load-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "local-only.md"),
        "---\ncli: claude\nexecution-policy: unrestricted\n---\nbody\n",
        "utf8",
      );

      const untrusted = loadAgentDefaults("local-only", { projectRoot: root, projectTrusted: false });
      assert.equal(
        untrusted,
        null,
        "untrusted project-local agent must not be loaded from .pi/agents",
      );

      const trusted = loadAgentDefaults("local-only", { projectRoot: root, projectTrusted: true });
      assert.ok(trusted, "trusted project-local agent must be loaded");
      assert.equal(trusted!.executionPolicy, "unrestricted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
