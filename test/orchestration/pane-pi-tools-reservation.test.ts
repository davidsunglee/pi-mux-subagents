// Pane-backed pi launches must reserve `subagent_done` and `caller_ping` in
// restrictive `--tools` allowlists, otherwise children cannot signal terminal
// completion or blocked state.
//
// The pane launch path writes the pi command script before dispatching via mux,
// so a fake surface can throw after the script is available for inspection.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSubagent } from "../../src/index.ts";

type LaunchParams = Parameters<typeof launchSubagent>[0];
type LaunchCtx = Parameters<typeof launchSubagent>[1];

async function captureLaunchScript(
  subagentParams: Partial<LaunchParams> & { name: string; task: string },
): Promise<string> {
  const sessionDir = mkdtempSync(join(tmpdir(), "pane-tools-"));
  const ctxCwd = mkdtempSync(join(tmpdir(), "pane-tools-ctx-"));
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

describe("pane pi launch --tools reserves lifecycle tools", () => {
  it("pane Pi command includes caller_ping and subagent_done in --tools when the agent restricts its tool set", async () => {
    const script = await captureLaunchScript({
      name: "pane-restricted", task: "hello", tools: "read, bash",
    });
    const m = script.match(/--tools '([^']+)'/);
    assert.ok(m, `expected --tools to be present in the pane pi script; got:\n${script}`);
    const tools = new Set(m![1].split(","));
    assert.ok(tools.has("read"));
    assert.ok(tools.has("bash"));
    assert.ok(
      tools.has("caller_ping"),
      "caller_ping must be in --tools so pane-backed pi children can ping the parent and enter blocked state",
    );
    assert.ok(
      tools.has("subagent_done"),
      "subagent_done must be in --tools so pane-backed pi children can signal terminal completion",
    );
  });

  it("pane Pi command omits --tools entirely when no tool restriction is supplied (no regression for unrestricted agents)", async () => {
    const script = await captureLaunchScript({
      name: "pane-unrestricted", task: "hello",
    });
    assert.equal(
      /--tools\s/.test(script),
      false,
      `unrestricted launches must not emit --tools: lifecycle tools are already available under pi defaults\nscript:\n${script}`,
    );
  });

  it("pane Pi command clears inherited PI_DENY_TOOLS when the child has no deny set", async () => {
    const previousDeniedTools = process.env.PI_DENY_TOOLS;
    process.env.PI_DENY_TOOLS = "subagent,subagent_run_serial";
    try {
      const script = await captureLaunchScript({
        name: "pane-unrestricted-env", task: "hello",
      });
      assert.match(
        script,
        /PI_DENY_TOOLS=''\s+PI_SUBAGENT_NAME='pane-unrestricted-env'/,
        `pane launch must clear inherited parent restrictions for unrestricted children\nscript:\n${script}`,
      );
    } finally {
      if (previousDeniedTools === undefined) delete process.env.PI_DENY_TOOLS;
      else process.env.PI_DENY_TOOLS = previousDeniedTools;
    }
  });

  it("pane Pi command includes orchestration token in --tools when the agent restricts its tool set with one", async () => {
    const script = await captureLaunchScript({
      name: "pane-coord", task: "hello", tools: "read, subagent_run_serial",
    });
    const m = script.match(/--tools '([^']+)'/);
    assert.ok(m, `expected --tools in pane pi script; got:\n${script}`);
    const tools = new Set(m![1].split(","));
    assert.ok(tools.has("read"));
    assert.ok(tools.has("subagent_run_serial"));
    assert.ok(tools.has("caller_ping"));
    assert.ok(tools.has("subagent_done"));
  });

  it("pane Pi launch rejects when spawning: false collides with an orchestration token in tools:", async () => {
    const root = mkdtempSync(join(tmpdir(), "pane-tools-conflict-root-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pane-tools-conflict-sess-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "bad-coord.md"),
        "---\nname: bad-coord\ntools: subagent_run_serial\nspawning: false\n---\nbad coord body\n",
        "utf8",
      );

      const ctx: LaunchCtx = {
        sessionManager: {
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => sessionDir,
        },
        cwd: sessionDir,
      };
      const params: LaunchParams = {
        cli: "pi",
        name: "pane-bad",
        task: "hi",
        agent: "bad-coord",
        cwd: root,
      };

      await assert.rejects(
        () => launchSubagent(params, ctx, { surface: "pi-test-fake-surface" }),
        /subagent_run_serial/,
      );
    } finally {
      // The throw must fire before sendLongCommand — no .sh script should exist.
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
      assert.equal(found.length, 0, `conflict throw must fire before sendLongCommand; found scripts: ${found.join(", ")}`);
      rmSync(root, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
