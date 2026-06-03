import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDefaultDeps } from "../../src/orchestration/default-deps.ts";
import {
  __test__ as subagentsTestHooks,
  unregisterHeadlessSubagent,
} from "../../src/index.ts";

describe("makeDefaultDeps.waitForCompletion", () => {
  it("returns transcriptPath: null (not undefined) when the handle is unknown", async () => {
    const deps = makeDefaultDeps({
      sessionManager: { getSessionFile: () => null } as any,
      cwd: process.cwd(),
    });
    const result = await deps.waitForCompletion({
      id: "does-not-exist",
      name: "ghost",
      startTime: Date.now(),
    });
    assert.equal(result.transcriptPath, null);
    assert.notEqual(result.transcriptPath, undefined);
    assert.equal(result.exitCode, 1);
    assert.ok(result.error);
  });
});

describe("makeDefaultDeps backend selection", () => {
  let origMode: string | undefined;
  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
  });

  it("routes to headless backend when PI_SUBAGENT_MODE=headless (abort-before-spawn yields aborted result)", async () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => "/tmp/fake-session.jsonl",
        getSessionId: () => "test-session",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: process.cwd(),
    });
    // Pre-aborted signal: headless backend short-circuits before spawn and
    // yields an "aborted" BackendResult. This proves routing (pane would
    // have thrown on missing mux) without requiring pi to be absent/present.
    const ac = new AbortController();
    ac.abort();
    const handle = await deps.launch(
      { agent: "x", task: "t" },
      false,
      ac.signal,
    );
    assert.ok(handle.id, "launch must resolve to a handle in headless mode");
    const result = await deps.waitForCompletion(handle);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, "aborted");
  });
});

describe("makeDefaultDeps headless registration honors agent frontmatter cli", () => {
  let origMode: string | undefined;
  let origCwd: string;
  let tmp: string;
  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    origCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "codex-fm-"));
    mkdirSync(join(tmp, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tmp, ".pi", "agents", "codex-fm-agent.md"),
      "---\ncli: codex\n---\n\nCodex agent selected via frontmatter only.\n",
    );
  });
  after(() => {
    process.chdir(origCwd);
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers cli=codex and claude status semantics when only agent frontmatter sets cli: codex", async () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    process.chdir(tmp);
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => join(tmp, "session.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => tmp,
      } as any,
      cwd: tmp,
    });
    const ac = new AbortController();
    ac.abort();
    // No task.cli: the codex selection comes solely from agent frontmatter.
    const handle = await deps.launch({ agent: "codex-fm-agent", task: "t" }, false, ac.signal);
    try {
      const running = subagentsTestHooks.getRunningSubagents().get(handle.id);
      assert.ok(running, "subagent must be registered in the headless registry");
      assert.equal(running.cli, "codex", "registry cli must reflect agent frontmatter cli: codex");
      assert.equal(
        running.statusState?.source,
        "claude",
        "codex must register with claude (no-activity-file) status semantics",
      );
    } finally {
      unregisterHeadlessSubagent(handle.id);
    }
  });
});
