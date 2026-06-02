import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCodexExecArgs, buildCodexPaneCmdParts, codexReasoningEffort, codexSandboxArgs } from "../../src/backends/codex-stream.ts";

const baseSpec: any = {
  name: "S",
  task: "do",
  effectiveCli: "codex",
  effectiveModel: undefined,
  codexModelArg: undefined,
  claudeModelArg: undefined,
  effectiveTools: undefined,
  effectiveSkills: undefined,
  effectiveThinking: undefined,
  skillPrompts: [],
  effectiveCwd: null,
  localAgentDir: null,
  effectiveAgentDir: "/tmp",
  configRootEnv: {},
  identity: null,
  identityInSystemPrompt: false,
  systemPromptMode: undefined,
  fullTask: "do",
  claudeTaskBody: "do",
  sessionMode: "standalone",
  seededSessionMode: null,
  inheritsConversationContext: false,
  taskDelivery: "direct",
  subagentSessionFile: "/tmp/x.jsonl",
  artifactDir: "/tmp",
  autoExit: false,
  effectiveInteractive: false,
  claudeCompletionAddendum: null,
  denySet: new Set<string>(),
  resumeSessionId: undefined,
  focus: undefined,
  effectiveExecutionPolicy: "guarded" as const,
  executionPolicySource: "default",
  agentDefs: null,
};

const baseOpts = { outputLastMessageFile: "/tmp/out.txt", cwd: "/workspace" };

describe("buildCodexExecArgs — headless guarded", () => {
  it("starts with exec and includes required flags", () => {
    const args = buildCodexExecArgs(baseSpec, baseOpts);
    assert.equal(args[0], "exec", "first arg must be 'exec'");
    assert.ok(args.includes("--json"), "must include --json");
    assert.ok(args.includes("--output-last-message"), "must include --output-last-message");
    assert.equal(args[args.indexOf("--output-last-message") + 1], "/tmp/out.txt");
    assert.ok(args.includes("--cd"), "must include --cd");
    assert.equal(args[args.indexOf("--cd") + 1], "/workspace");
    assert.ok(args.includes("--skip-git-repo-check"), "must include --skip-git-repo-check");
  });

  it("guarded headless includes --sandbox workspace-write and approval_policy never", () => {
    const args = buildCodexExecArgs(baseSpec, baseOpts);
    assert.ok(args.includes("--sandbox"), "guarded headless must include --sandbox");
    assert.ok(args.includes("workspace-write"), "must include workspace-write");
    assert.ok(args.some((a) => a.includes('approval_policy="never"')), "must include approval_policy=never config");
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false,
      "guarded must NOT include --dangerously-bypass-approvals-and-sandbox");
  });

  it("unrestricted headless includes bypass flag and no --sandbox", () => {
    const args = buildCodexExecArgs({ ...baseSpec, effectiveExecutionPolicy: "unrestricted" }, baseOpts);
    assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"),
      "unrestricted must include --dangerously-bypass-approvals-and-sandbox");
    assert.equal(args.includes("--sandbox"), false, "unrestricted must not include --sandbox");
  });

  it("resumeSessionId set → argv starts exec resume <id>", () => {
    const args = buildCodexExecArgs({ ...baseSpec, resumeSessionId: "ses-abc-123" }, baseOpts);
    assert.equal(args[0], "exec");
    assert.equal(args[1], "resume");
    assert.equal(args[2], "ses-abc-123");
  });

  it("codexModelArg → --model <bare>", () => {
    const args = buildCodexExecArgs({ ...baseSpec, codexModelArg: "gpt-5.4-mini" }, baseOpts);
    const idx = args.indexOf("--model");
    assert.notEqual(idx, -1, "--model must be in args");
    assert.equal(args[idx + 1], "gpt-5.4-mini");
  });

  it("thinking 'high' → -c model_reasoning_effort=high", () => {
    const args = buildCodexExecArgs({ ...baseSpec, effectiveThinking: "high" }, baseOpts);
    const idx = args.indexOf("-c");
    assert.notEqual(idx, -1, "-c must be in args");
    assert.ok(args[idx + 1].includes('model_reasoning_effort="high"'), `expected effort config, got: ${args[idx + 1]}`);
  });

  it("thinking 'off' → no model_reasoning_effort token", () => {
    const args = buildCodexExecArgs({ ...baseSpec, effectiveThinking: "off" }, baseOpts);
    assert.ok(!args.some((a) => a.includes("model_reasoning_effort")),
      "unknown thinking value 'off' must produce no model_reasoning_effort token");
  });
});

describe("codexReasoningEffort", () => {
  it("returns valid effort values unchanged", () => {
    for (const v of ["minimal", "low", "medium", "high", "xhigh"]) {
      assert.equal(codexReasoningEffort(v), v);
    }
  });

  it("returns undefined for unknown values including off", () => {
    assert.equal(codexReasoningEffort("off"), undefined);
    assert.equal(codexReasoningEffort("unknown"), undefined);
    assert.equal(codexReasoningEffort(undefined), undefined);
  });

  it("normalizes case", () => {
    assert.equal(codexReasoningEffort("HIGH"), "high");
    assert.equal(codexReasoningEffort("Medium"), "medium");
  });
});

describe("codexSandboxArgs", () => {
  it("guarded headless returns --sandbox workspace-write -c approval_policy=never", () => {
    const args = codexSandboxArgs("guarded", "headless");
    assert.deepEqual(args, ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']);
  });

  it("guarded pane returns --sandbox workspace-write --ask-for-approval on-request", () => {
    const args = codexSandboxArgs("guarded", "pane");
    assert.deepEqual(args, ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  });

  it("unrestricted returns --dangerously-bypass-approvals-and-sandbox for both transports", () => {
    assert.deepEqual(codexSandboxArgs("unrestricted", "headless"), ["--dangerously-bypass-approvals-and-sandbox"]);
    assert.deepEqual(codexSandboxArgs("unrestricted", "pane"), ["--dangerously-bypass-approvals-and-sandbox"]);
  });
});

describe("buildCodexPaneCmdParts", () => {
  it("guarded pane → --ask-for-approval on-request (not --dangerously-bypass)", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "guarded",
      mcpOverrideArgs: [],
      task: "do the thing",
    });
    const joined = parts.join(" ");
    assert.ok(joined.includes("--ask-for-approval"), "guarded pane must include --ask-for-approval");
    assert.ok(joined.includes("on-request"), "guarded pane must include on-request");
    assert.equal(joined.includes("--dangerously-bypass-approvals-and-sandbox"), false,
      "guarded pane must not include bypass flag");
  });

  it("unrestricted pane → bypass flag, no --sandbox", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "unrestricted",
      mcpOverrideArgs: [],
      task: "do the thing",
    });
    const joined = parts.join(" ");
    assert.ok(joined.includes("--dangerously-bypass-approvals-and-sandbox"),
      "unrestricted pane must include bypass flag");
    assert.equal(joined.includes("--sandbox"), false, "unrestricted must not include --sandbox");
  });

  it("mcpOverrideArgs tokens are present in pane parts", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "guarded",
      mcpOverrideArgs: ["-c", 'mcp_servers.pi_subagent.command="node"'],
      task: "t",
    });
    const joined = parts.join(" ");
    assert.ok(joined.includes("mcp_servers.pi_subagent.command"), "mcpOverrideArgs must appear in pane parts");
  });

  it("task prompt appears after --", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "guarded",
      mcpOverrideArgs: [],
      task: "the task text here",
    });
    const ddIdx = parts.indexOf("--");
    assert.notEqual(ddIdx, -1, "-- separator must be present");
    const remaining = parts.slice(ddIdx + 1).join(" ");
    assert.ok(remaining.includes("the task text here"), "prompt must appear after --");
  });

  it("empty task does not emit -- or prompt", () => {
    const parts = buildCodexPaneCmdParts({
      executionPolicy: "guarded",
      mcpOverrideArgs: [],
      task: "",
    });
    assert.equal(parts.includes("--"), false, "empty task must not emit -- separator");
  });

  it("model is included when provided", () => {
    const parts = buildCodexPaneCmdParts({
      model: "gpt-5.4-mini",
      executionPolicy: "guarded",
      mcpOverrideArgs: [],
      task: "t",
    });
    assert.ok(parts.includes("--model"), "--model must appear");
    // model value is shell-escaped so check the joined string
    assert.ok(parts.join(" ").includes("gpt-5.4-mini"), "model value must appear in joined pane parts");
  });
});
