import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAgentDefaults,
  resolveLaunchSpec,
  warnGuardedPolicyUnsupported,
  writeSystemPromptArtifact,
} from "../../src/launch/launch-spec.ts";
import { createDiagnosticCollector } from "../../src/diagnostics/diagnostics.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("resolveLaunchSpec", () => {
  it("propagates direct fields when no agent is given", () => {
    const spec = resolveLaunchSpec(
      {
        name: "S1",
        task: "do",
        model: "anthropic/claude-haiku-4-5",
        thinking: "medium",
        cli: "pi",
        tools: "read,bash",
      },
      baseCtx,
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-haiku-4-5");
    assert.equal(spec.effectiveThinking, "medium");
    assert.equal(spec.effectiveCli, "pi");
    assert.equal(spec.effectiveTools, "read,bash");
    assert.equal(spec.sessionMode, "standalone");
    assert.equal(spec.taskDelivery, "artifact");
    assert.equal(spec.autoExit, false);
    assert.deepEqual([...spec.denySet], []);
  });

  it("computes a shared claudeModelArg once so pane + headless Claude stay in sync", () => {
    const prefixed = resolveLaunchSpec(
      { name: "C1", task: "do", cli: "claude", model: "anthropic/claude-haiku-4-5" },
      baseCtx,
    );
    assert.equal(prefixed.effectiveModel, "anthropic/claude-haiku-4-5");
    assert.equal(prefixed.claudeModelArg, "claude-haiku-4-5");

    const bare = resolveLaunchSpec(
      { name: "C2", task: "do", cli: "claude", model: "claude-sonnet-4-6" },
      baseCtx,
    );
    assert.equal(bare.claudeModelArg, "claude-sonnet-4-6");
  });

  it("defaults execution policy to guarded", () => {
    const spec = resolveLaunchSpec(
      { name: "PolicyDefault", task: "do", cli: "claude" },
      baseCtx,
    );
    assert.equal(spec.effectiveExecutionPolicy, "guarded");
    assert.equal(spec.executionPolicySource, "default");
  });

  it("loads execution-policy frontmatter and lets params override it", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-exec-policy-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "policy-agent.md"),
        "---\ncli: claude\nexecution-policy: unrestricted\n---\npolicy body\n",
        "utf8",
      );

      const fromAgent = resolveLaunchSpec(
        { name: "PolicyAgent", task: "do", agent: "policy-agent", cwd: root },
        baseCtx,
      );
      assert.equal(fromAgent.effectiveExecutionPolicy, "unrestricted");
      assert.equal(fromAgent.executionPolicySource, "agent");

      const fromParams = resolveLaunchSpec(
        {
          name: "PolicyOverride",
          task: "do",
          agent: "policy-agent",
          cwd: root,
          executionPolicy: "guarded",
        },
        baseCtx,
      );
      assert.equal(fromParams.effectiveExecutionPolicy, "guarded");
      assert.equal(fromParams.executionPolicySource, "params");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns when guarded is explicitly requested for a non-Claude backend", () => {
    const collector = createDiagnosticCollector();
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = () => true; // suppress the human-channel stderr line
    try {
      warnGuardedPolicyUnsupported(
        { name: "PiWorker", effectiveCli: "pi", effectiveExecutionPolicy: "guarded", executionPolicySource: "params" },
        { collector },
      );
    } finally {
      (process.stderr as any).write = orig;
    }
    const warnings = collector.drain();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /execution-policy=guarded requested/);
    assert.match(warnings[0], /'pi' backend has no guarded mode/);
  });

  it("does not warn for the implicit guarded default, unrestricted, or Claude", () => {
    const collector = createDiagnosticCollector();
    // implicit default → no nag on routine pi launches
    warnGuardedPolicyUnsupported(
      { name: "A", effectiveCli: "pi", effectiveExecutionPolicy: "guarded", executionPolicySource: "default" },
      { collector },
    );
    // unrestricted is honored by pi today → nothing to warn about
    warnGuardedPolicyUnsupported(
      { name: "B", effectiveCli: "pi", effectiveExecutionPolicy: "unrestricted", executionPolicySource: "params" },
      { collector },
    );
    // Claude implements guarded → no warning
    warnGuardedPolicyUnsupported(
      { name: "C", effectiveCli: "claude", effectiveExecutionPolicy: "guarded", executionPolicySource: "params" },
      { collector },
    );
    assert.deepEqual(collector.drain(), []);
  });

  it("loads agent defaults and lets params override them", () => {
    const spec = resolveLaunchSpec(
      { name: "S2", task: "ping", agent: "test-echo", model: "anthropic/claude-sonnet-4-5" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-sonnet-4-5");
    assert.equal(spec.effectiveTools, "read, bash, write, edit");
    assert.equal(spec.autoExit, true);
    assert.ok(spec.denySet.has("subagent_run_serial"));
  });

  it("flips taskDelivery to direct only when fork (or agent session-mode=fork) is set", () => {
    const a = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.equal(a.taskDelivery, "artifact");
    const b = resolveLaunchSpec({ name: "X", task: "t", fork: true }, baseCtx);
    assert.equal(b.taskDelivery, "direct");
    assert.equal(b.sessionMode, "fork");
  });

  it("expands skill names into /skill: prompts in spec.skillPrompts", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", skills: "foo, bar" },
      baseCtx,
    );
    assert.deepEqual(spec.skillPrompts, ["/skill:foo", "/skill:bar"]);
  });

  it("threads resumeSessionId through unchanged", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", resumeSessionId: "abc-123" },
      baseCtx,
    );
    assert.equal(spec.resumeSessionId, "abc-123");
  });

  it("system-prompt mode 'replace' marks identityInSystemPrompt with --system-prompt flag", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "you are a sentinel" },
      baseCtx,
    );
    assert.equal(spec.identity, "you are a sentinel");
    assert.equal(spec.identityInSystemPrompt, false);
    assert.match(spec.fullTask, /you are a sentinel/);
  });

  it("composes identity from agent body + caller systemPrompt when both are set (TODO-dd074bb7)", () => {
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "t",
        agent: "test-echo",
        systemPrompt: "CALLER_PROMPT_INSTRUCTION",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.ok(spec.identity, "identity must be non-null when agent body present");
    // Both the agent body and the caller's per-call systemPrompt must
    // participate in the composed identity.
    assert.match(
      spec.identity!,
      /You are a test agent\. Complete the task given to you immediately/,
      "composed identity must contain the agent body",
    );
    assert.match(
      spec.identity!,
      /CALLER_PROMPT_INSTRUCTION/,
      "composed identity must include the caller systemPrompt — TODO-dd074bb7 fix is composition, not precedence",
    );
    // Order: body first, blank line, caller prompt second.
    const bodyIdx = spec.identity!.indexOf("You are a test agent");
    const callerIdx = spec.identity!.indexOf("CALLER_PROMPT_INSTRUCTION");
    assert.ok(bodyIdx >= 0 && callerIdx > bodyIdx,
      `agent body must appear before caller prompt in composed identity, got: ${spec.identity}`);
    assert.ok(
      spec.identity!.slice(bodyIdx, callerIdx).includes("\n\n"),
      `composed identity must use a blank-line separator between body and caller prompt, got: ${JSON.stringify(spec.identity)}`,
    );
    // Each non-empty source must appear exactly once.
    const callerOccurrences = (spec.identity!.match(/CALLER_PROMPT_INSTRUCTION/g) || []).length;
    assert.equal(callerOccurrences, 1, "caller systemPrompt must appear exactly once in composed identity");
  });

  it("composes identity using agent body alone when caller systemPrompt is absent (TODO-dd074bb7)", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", agent: "test-echo" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.ok(spec.identity, "identity must be non-null when agent body present");
    // Trimmed agent body — no extra leading/trailing whitespace.
    assert.equal(
      spec.identity,
      spec.identity!.trim(),
      "agent-only identity must be the trimmed agent body (no extra whitespace)",
    );
    assert.match(spec.identity!, /You are a test agent\./);
  });

  it("uses caller systemPrompt alone when agent has no body (TODO-dd074bb7)", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "  caller-only-identity  " },
      baseCtx,
    );
    assert.equal(
      spec.identity,
      "caller-only-identity",
      "caller-only identity must be the trimmed caller systemPrompt",
    );
  });

  it("ignores whitespace-only agent body and whitespace-only caller systemPrompt (TODO-dd074bb7)", () => {
    // Whitespace-only systemPrompt with no agent body → identity is null.
    const blank = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "   \n\t   " },
      baseCtx,
    );
    assert.equal(blank.identity, null,
      "whitespace-only caller systemPrompt with no agent body must yield null identity");

    // Whitespace-only systemPrompt + non-empty agent body → identity is just the agent body.
    const onlyBody = resolveLaunchSpec(
      { name: "X", task: "t", agent: "test-echo", systemPrompt: "   \n   " },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.ok(onlyBody.identity, "agent-body-only identity must be non-null");
    assert.equal(
      onlyBody.identity,
      onlyBody.identity!.trim(),
      "whitespace-only caller systemPrompt must be ignored, leaving only the agent body",
    );
    assert.doesNotMatch(onlyBody.identity!, /\s{3,}$/,
      "no trailing whitespace from the dropped caller systemPrompt");
  });

  it("returns null identity when both sources are empty/whitespace (TODO-dd074bb7)", () => {
    const noBody = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.equal(noBody.identity, null, "no agent and no systemPrompt → identity null");

    const blankBoth = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "  " },
      baseCtx,
    );
    assert.equal(blankBoth.identity, null, "whitespace-only systemPrompt and no agent → identity null");

    const root = mkdtempSync(join(tmpdir(), "ls-blank-body-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "blank-body.md"),
        "---\nmodel: m\n---\n   \n\t\n",
        "utf8",
      );
      const whitespaceBodyAndPrompt = resolveLaunchSpec(
        { name: "X", task: "t", agent: "blank-body", cwd: root, systemPrompt: " \n\t " },
        baseCtx,
      );
      assert.equal(whitespaceBodyAndPrompt.identity, null,
        "whitespace-only agent body and whitespace-only systemPrompt → identity null");

      const whitespaceBodyOnly = resolveLaunchSpec(
        { name: "X", task: "t", agent: "blank-body", cwd: root, systemPrompt: " caller survives " },
        baseCtx,
      );
      assert.equal(whitespaceBodyOnly.identity, "caller survives",
        "whitespace-only agent body must be ignored while non-empty caller systemPrompt is retained");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("trims surrounding whitespace from each source before composition (TODO-dd074bb7)", () => {
    // Use an inline tmp agent fixture so we control exact body whitespace.
    const root = mkdtempSync(join(tmpdir(), "ls-trim-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "trim-agent.md"),
        "---\nmodel: m\n---\n\n   AGENT_BODY_RAW   \n\n",
        "utf8",
      );
      const spec = resolveLaunchSpec(
        {
          name: "T",
          task: "t",
          agent: "trim-agent",
          cwd: root,
          systemPrompt: "  \n  CALLER_RAW  \n  ",
        },
        baseCtx,
      );
      assert.equal(
        spec.identity,
        "AGENT_BODY_RAW\n\nCALLER_RAW",
        `composed identity must trim each source before joining with a blank-line separator; got: ${JSON.stringify(spec.identity)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate composed identity in claudeTaskBody when both sources are present (TODO-dd074bb7)", () => {
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "do-task",
        agent: "test-echo",
        systemPrompt: "CALLER_LEAK_CHECK",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    // Claude path strips the role block from the task body — the composed
    // identity is transported via the system-prompt flag, not duplicated in
    // the task argv.
    assert.doesNotMatch(spec.claudeTaskBody, /You are a test agent\./,
      "agent body must not leak into Claude task body");
    assert.doesNotMatch(spec.claudeTaskBody, /CALLER_LEAK_CHECK/,
      "caller systemPrompt must not leak into Claude task body — it travels via --append-system-prompt");
    assert.match(spec.claudeTaskBody, /do-task/);
  });

  it("places composed identity in fullTask role block when no system-prompt mode is set (TODO-dd074bb7)", () => {
    // No system-prompt mode → identity must be wrapped into the task as a
    // role block exactly once on the pi path.
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "do-task",
        agent: "test-echo",
        systemPrompt: "CALLER_ROLE_BLOCK",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(spec.identityInSystemPrompt, false,
      "test-echo agent has no system-prompt mode → identity stays in role block");
    const callerHits = (spec.fullTask.match(/CALLER_ROLE_BLOCK/g) || []).length;
    assert.equal(callerHits, 1,
      "composed identity must appear exactly once in fullTask when transported via role block");
    const bodyHits = (spec.fullTask.match(/You are a test agent\./g) || []).length;
    assert.equal(bodyHits, 1, "agent body must appear exactly once in fullTask");
  });

  it("routes composed identity through the system-prompt flag when agent has system-prompt: append/replace (TODO-dd074bb7)", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-spm-compose-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "spm-append.md"),
        "---\nmodel: m\nsystem-prompt: append\n---\nAGENT_BODY_APPEND\n",
        "utf8",
      );
      writeFileSync(
        join(root, ".pi", "agents", "spm-replace.md"),
        "---\nmodel: m\nsystem-prompt: replace\n---\nAGENT_BODY_REPLACE\n",
        "utf8",
      );

      const append = resolveLaunchSpec(
        {
          name: "A",
          task: "do-task",
          agent: "spm-append",
          cwd: root,
          systemPrompt: "CALLER_APPEND",
        },
        baseCtx,
      );
      assert.equal(append.identityInSystemPrompt, true);
      assert.equal(append.systemPromptMode, "append");
      assert.equal(append.identity, "AGENT_BODY_APPEND\n\nCALLER_APPEND",
        "append mode must still receive the composed identity");
      // Identity must NOT also be wrapped into the task body.
      assert.doesNotMatch(append.fullTask, /AGENT_BODY_APPEND/,
        "system-prompt mode set → identity stays out of fullTask");
      assert.doesNotMatch(append.fullTask, /CALLER_APPEND/,
        "system-prompt mode set → caller prompt also stays out of fullTask (it is part of the composed identity)");

      const replace = resolveLaunchSpec(
        {
          name: "R",
          task: "do-task",
          agent: "spm-replace",
          cwd: root,
          systemPrompt: "CALLER_REPLACE",
        },
        baseCtx,
      );
      assert.equal(replace.identityInSystemPrompt, true);
      assert.equal(replace.systemPromptMode, "replace");
      assert.equal(replace.identity, "AGENT_BODY_REPLACE\n\nCALLER_REPLACE",
        "replace mode must transport the same composed identity (transport flag differs only)");
      assert.doesNotMatch(replace.fullTask, /AGENT_BODY_REPLACE/);
      assert.doesNotMatch(replace.fullTask, /CALLER_REPLACE/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("Codex identity delivery (no system-prompt channel)", () => {
    function seedCodexAgent(name: string, frontmatter: string, body: string) {
      const root = mkdtempSync(join(tmpdir(), "ls-codex-identity-"));
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", `${name}.md`),
        `---\n${frontmatter}\n---\n${body}\n`,
        "utf8",
      );
      return root;
    }

    it("system-prompt: append on Codex keeps identity in the task body (pane neutralCore + headless fullTask)", () => {
      const root = seedCodexAgent(
        "codex-append",
        "cli: codex\nsystem-prompt: append",
        "CODEX_AGENT_BODY_APPEND",
      );
      try {
        const spec = resolveLaunchSpec(
          { name: "A", task: "do-task", agent: "codex-append", cwd: root, systemPrompt: "CALLER_CODEX_APPEND" },
          baseCtx,
        );
        assert.equal(spec.paneBackend, "codex");
        assert.equal(spec.systemPromptMode, "append");
        assert.equal(spec.identityInSystemPrompt, false,
          "Codex has no system-prompt channel → identity must stay in the task body even with system-prompt: append");
        // Pane path consumes neutralCore; headless path writes fullTask to stdin.
        assert.match(spec.neutralCore, /CODEX_AGENT_BODY_APPEND/,
          "Codex pane neutralCore must carry the agent body");
        assert.match(spec.neutralCore, /CALLER_CODEX_APPEND/,
          "Codex pane neutralCore must carry the per-call systemPrompt");
        assert.match(spec.fullTask, /CODEX_AGENT_BODY_APPEND/,
          "Codex headless fullTask must carry the agent body");
        assert.match(spec.fullTask, /CALLER_CODEX_APPEND/,
          "Codex headless fullTask must carry the per-call systemPrompt");
        // No duplication: body appears exactly once in each delivered prompt.
        assert.equal((spec.neutralCore.match(/CODEX_AGENT_BODY_APPEND/g) || []).length, 1);
        assert.equal((spec.fullTask.match(/CODEX_AGENT_BODY_APPEND/g) || []).length, 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("system-prompt: replace on Codex delivers identity additively in the task body", () => {
      const root = seedCodexAgent(
        "codex-replace",
        "cli: codex\nsystem-prompt: replace",
        "CODEX_AGENT_BODY_REPLACE",
      );
      try {
        const spec = resolveLaunchSpec(
          { name: "R", task: "do-task", agent: "codex-replace", cwd: root },
          baseCtx,
        );
        assert.equal(spec.paneBackend, "codex");
        assert.equal(spec.systemPromptMode, "replace");
        assert.equal(spec.identityInSystemPrompt, false,
          "Codex replace is best-effort additive: identity stays in the task body");
        assert.match(spec.neutralCore, /CODEX_AGENT_BODY_REPLACE/);
        assert.match(spec.fullTask, /CODEX_AGENT_BODY_REPLACE/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("delivers a test-runner-shaped artifact contract from the body to the Codex prompt", () => {
      // Models pi-flow's test-runner: the artifact-format contract lives in the
      // agent body and is routed through system-prompt: append. On Codex the
      // contract must survive into the delivered prompt (pane + headless).
      const TEST_RUNNER_BODY = [
        "Emit your result artifact in EXACTLY this format:",
        "",
        "COMMAND: <the test command you ran>",
        "EXIT_CODE: <numeric exit code>",
        "BEGIN_FAILING_IDENTIFIERS",
        "<one failing test id per line>",
        "END_FAILING_IDENTIFIERS",
        "",
        "--- RAW RUN OUTPUT BELOW ---",
        "<verbatim output>",
      ].join("\n");
      const root = seedCodexAgent(
        "codex-test-runner",
        "cli: codex\nsystem-prompt: append\nauto-exit: true",
        TEST_RUNNER_BODY,
      );
      try {
        const spec = resolveLaunchSpec(
          { name: "TR", task: "run the tests", agent: "codex-test-runner", cwd: root },
          baseCtx,
        );
        assert.equal(spec.identityInSystemPrompt, false);
        for (const marker of ["COMMAND:", "EXIT_CODE:", "END_FAILING_IDENTIFIERS", "--- RAW RUN OUTPUT BELOW ---"]) {
          assert.ok(spec.neutralCore.includes(marker),
            `Codex pane prompt must include artifact marker ${JSON.stringify(marker)}`);
          assert.ok(spec.fullTask.includes(marker),
            `Codex headless prompt must include artifact marker ${JSON.stringify(marker)}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("pi keeps mode-gated routing: system-prompt: append routes identity to the flag (unchanged)", () => {
      const root = seedCodexAgent(
        "pi-append",
        "model: m\nsystem-prompt: append",
        "PI_AGENT_BODY_APPEND",
      );
      try {
        const spec = resolveLaunchSpec(
          { name: "P", task: "do-task", agent: "pi-append", cwd: root },
          baseCtx,
        );
        assert.equal(spec.paneBackend, "pi");
        assert.equal(spec.identityInSystemPrompt, true,
          "pi retains its hybrid routing: mode set → identity via the system-prompt flag, not the body");
        assert.doesNotMatch(spec.fullTask, /PI_AGENT_BODY_APPEND/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("exposes claudeTaskBody without the roleBlock for Claude backends to consume", () => {
    const blank = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y" },
      baseCtx,
    );
    assert.match(blank.fullTask, /you are Y/);
    assert.doesNotMatch(blank.claudeTaskBody, /you are Y/,
      "review-v11 finding 1 regression: identity text leaked into claudeTaskBody — Claude would see it via the flag AND the task body");
    assert.match(blank.claudeTaskBody, /do-task/);

    const fork = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y", fork: true },
      baseCtx,
    );
    assert.equal(fork.claudeTaskBody, "do-task");
  });

  it("places subagentSessionFile under getDefaultSessionDirFor(targetCwd, agentDir)", () => {
    const spec = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.match(spec.subagentSessionFile, /\.jsonl$/);
    assert.match(spec.subagentSessionFile, /sessions\/--tmp--\//);
  });

  it("resolves agent defaults from the target project's .pi/agents/ when params.cwd points into another repo (review finding 1)", () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "ls-parent-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "ls-target-"));
    try {
      // Seed two different agents with the same name at the two roots so we
      // can prove which one won.
      mkdirSync(join(parentRoot, ".pi", "agents"), { recursive: true });
      mkdirSync(join(targetRoot, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(parentRoot, ".pi", "agents", "contested.md"),
        "---\nmodel: parent-model\ntools: read\n---\nparent body\n",
        "utf8",
      );
      writeFileSync(
        join(targetRoot, ".pi", "agents", "contested.md"),
        "---\nmodel: target-model\ntools: bash\n---\ntarget body\n",
        "utf8",
      );

      const ctx = {
        sessionManager: baseCtx.sessionManager,
        cwd: parentRoot,
      };
      const spec = resolveLaunchSpec(
        { name: "Z", task: "t", agent: "contested", cwd: targetRoot },
        ctx,
      );
      assert.equal(
        spec.effectiveModel,
        "target-model",
        "agent lookup must follow params.cwd target, not parent ctx.cwd",
      );
      assert.equal(spec.effectiveTools, "bash");
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative params.cwd against ctx.cwd, not process.cwd() (review-v2 finding 1)", () => {
    // Regression: resolveSubagentPaths used to resolve relative params.cwd
    // against process.cwd(). If the session cwd differs from the Node process
    // cwd, that split the launch-spec contract: agent lookup followed one tree
    // while session placement/config-root followed another.
    const sessionRoot = mkdtempSync(join(tmpdir(), "ls-session-"));
    try {
      const ctx = {
        sessionManager: baseCtx.sessionManager,
        cwd: sessionRoot,
      };
      const spec = resolveLaunchSpec(
        { name: "R", task: "t", cwd: "sub/dir" },
        ctx,
      );
      assert.equal(
        spec.effectiveCwd,
        join(sessionRoot, "sub", "dir"),
        "relative params.cwd must resolve against ctx.cwd",
      );
      // And session placement must follow the same root — the session path
      // is keyed on effectiveCwd, so if this passes, the derived session dir
      // is under the ctx.cwd tree too.
      const expectedSegment = `--${sessionRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}-sub-dir--`;
      assert.ok(
        spec.subagentSessionFile.includes(expectedSegment),
        `session file must be keyed on ctx.cwd-relative path, got ${spec.subagentSessionFile}`,
      );
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("throws when spawning: false collides with an orchestration token in tools:", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-bad-coord-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "bad-coord.md"),
        "---\nname: bad-coord\ntools: read, subagent_run_serial\nspawning: false\n---\nbody\n",
        "utf8",
      );
      assert.throws(
        () =>
          resolveLaunchSpec(
            { name: "X", task: "t", agent: "bad-coord", cwd: root },
            baseCtx,
          ),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("spawning: false"),
            `expected "spawning: false" in message, got: ${err.message}`,
          );
          assert.ok(
            err.message.includes("subagent_run_serial"),
            `expected "subagent_run_serial" in message, got: ${err.message}`,
          );
          assert.ok(
            /cli:\s*pi/i.test(err.message),
            `expected hint about pi-backed coordinator (cli: pi), got: ${err.message}`,
          );
          assert.ok(
            /Claude CLI/i.test(err.message),
            `expected hint that Claude CLI does not expose pi orchestration tools, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps spawning: false → SPAWNING_TOOLS deny-set when no orchestration token is listed", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-strict-worker-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "strict-worker.md"),
        "---\ntools: read, bash\nspawning: false\n---\nbody\n",
        "utf8",
      );
      const spec = resolveLaunchSpec(
        { name: "X", task: "t", agent: "strict-worker", cwd: root },
        baseCtx,
      );
      assert.ok(spec.denySet.has("subagent"), "denySet must contain subagent");
      assert.ok(spec.denySet.has("subagents_list"), "denySet must contain subagents_list");
      assert.ok(spec.denySet.has("subagent_resume"), "denySet must contain subagent_resume");
      assert.ok(spec.denySet.has("subagent_run_serial"), "denySet must contain subagent_run_serial");
      assert.ok(spec.denySet.has("subagent_run_parallel"), "denySet must contain subagent_run_parallel");
      assert.ok(spec.denySet.has("subagent_run_cancel"), "denySet must contain subagent_run_cancel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadAgentDefaults({ projectRoot }) searches the specified root before global/bundled", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agent-root-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "fixture-only.md"),
        "---\nmodel: local-model\n---\nlocal body\n",
        "utf8",
      );
      const defs = loadAgentDefaults("fixture-only", { projectRoot: root });
      assert.ok(defs, "defs should be loaded from explicit projectRoot");
      assert.equal(defs!.model, "local-model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Pi system-prompt artifact contains the composed identity verbatim and the role-block does not duplicate it (TODO-dd074bb7)", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-pi-sp-artifact-"));
    const artifactRoot = mkdtempSync(join(tmpdir(), "ls-pi-sp-out-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "spm-append.md"),
        "---\nmodel: m\nsystem-prompt: append\n---\nAGENT_BODY_PI_APPEND\n",
        "utf8",
      );
      const spec = resolveLaunchSpec(
        {
          name: "X",
          task: "do-task-text",
          agent: "spm-append",
          cwd: root,
          systemPrompt: "PER_CALL_PI_APPEND",
        },
        {
          sessionManager: {
            getSessionFile: () => join(artifactRoot, "parent.jsonl"),
            getSessionId: () => "sess-pi-sp",
            getSessionDir: () => artifactRoot,
          } as any,
          cwd: artifactRoot,
        },
      );
      assert.equal(spec.identityInSystemPrompt, true);
      assert.equal(spec.systemPromptMode, "append");
      const path = writeSystemPromptArtifact(spec);
      assert.ok(path, "writeSystemPromptArtifact must return a path when identityInSystemPrompt is true");
      const onDisk = readFileSync(path!, "utf8");
      assert.equal(onDisk, "AGENT_BODY_PI_APPEND\n\nPER_CALL_PI_APPEND",
        "Pi system-prompt artifact must contain the composed identity (body + blank line + caller prompt)");
      // Identity must NOT also be wrapped into the task body when transported via flag.
      assert.doesNotMatch(spec.fullTask, /AGENT_BODY_PI_APPEND/,
        "agent body must not also leak into fullTask when transported via system-prompt artifact");
      assert.doesNotMatch(spec.fullTask, /PER_CALL_PI_APPEND/,
        "caller systemPrompt must not also leak into fullTask when transported via system-prompt artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it("Pi role-block path embeds the composed identity once in fullTask when no system-prompt mode is set (TODO-dd074bb7)", () => {
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "do-task-text",
        agent: "test-echo",
        systemPrompt: "PER_CALL_ROLE_BLOCK",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(spec.identityInSystemPrompt, false,
      "no system-prompt mode → identity stays in role-block path");
    // Each non-empty source must appear exactly once.
    const callerHits = (spec.fullTask.match(/PER_CALL_ROLE_BLOCK/g) || []).length;
    assert.equal(callerHits, 1,
      "caller systemPrompt must appear exactly once when transported via role block");
    const bodyHits = (spec.fullTask.match(/You are a test agent\./g) || []).length;
    assert.equal(bodyHits, 1,
      "agent body must appear exactly once when transported via role block");
    // Verify the role-block ordering: body first, then caller prompt, with a blank line between.
    const bodyIdx = spec.fullTask.indexOf("You are a test agent");
    const callerIdx = spec.fullTask.indexOf("PER_CALL_ROLE_BLOCK");
    assert.ok(bodyIdx >= 0 && callerIdx > bodyIdx,
      "agent body must precede caller prompt in role block");
    assert.ok(spec.fullTask.slice(bodyIdx, callerIdx).includes("\n\n"),
      "blank-line separator between body and caller prompt in role block");
  });

  describe("paneBackend + neutralCore + seam-sourced claudeCompletionAddendum", () => {
    const CLAUDE_INTERACTIVE =
      "You are an interactive subagent. The user can type into this pane at any time — feel free to ask clarifying questions as many times as needed. When the task is complete, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.";
    const CLAUDE_AUTONOMOUS =
      "You are a one-shot subagent. Complete your task autonomously without asking the user questions. When finished, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.";

    it("paneBackend defaults to 'pi' when no cli is given", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "t" }, baseCtx);
      assert.equal(spec.paneBackend, "pi");
    });

    it("paneBackend is 'claude' for cli: 'claude'", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "t", cli: "claude" }, baseCtx);
      assert.equal(spec.paneBackend, "claude");
    });

    it("paneBackend is 'codex' for cli: 'codex'", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "t", cli: "codex" }, baseCtx);
      assert.equal(spec.paneBackend, "codex");
    });

    it("paneBackend falls through to 'pi' for unknown cli (legacy behavior preserved)", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "t", cli: "opencode" }, baseCtx);
      assert.equal(spec.paneBackend, "pi");
    });

    it("neutralCore contains the task body and excludes completion wording", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "TASKBODY" }, baseCtx);
      assert.match(spec.neutralCore, /TASKBODY/);
      assert.doesNotMatch(spec.neutralCore, /Complete your task/);
      assert.doesNotMatch(spec.neutralCore, /FINAL assistant message/);
    });

    it("fullTask still contains completion wording (byte-stable derived output)", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "TASKBODY" }, baseCtx);
      assert.match(spec.fullTask, /Complete your task/);
      assert.match(spec.fullTask, /FINAL assistant message/);
    });

    it("neutralCore includes identity (role block) when systemPrompt is set", () => {
      const spec = resolveLaunchSpec({ name: "N", task: "T", systemPrompt: "ROLE_X" }, baseCtx);
      assert.match(spec.neutralCore, /ROLE_X/);
      assert.doesNotMatch(spec.neutralCore, /Complete your task/);
    });

    it("claudeCompletionAddendum equals the Reference interactive Claude string for cli: 'claude'", () => {
      const spec = resolveLaunchSpec({ name: "C", task: "t", cli: "claude" }, baseCtx);
      assert.equal(spec.claudeCompletionAddendum, CLAUDE_INTERACTIVE);
    });

    it("claudeCompletionAddendum equals the Reference autonomous Claude string when agent declares auto-exit: true", () => {
      const spec = resolveLaunchSpec(
        { name: "C", task: "t", agent: "test-echo", cli: "claude" },
        baseCtx,
        { agentSearchDirs: ["test/integration/agents"] },
      );
      assert.equal(spec.claudeCompletionAddendum, CLAUDE_AUTONOMOUS);
    });
  });
});
