import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  PaneBackend,
  PaneExecutionMode,
  PaneCompletionProtocol,
} from "../../src/launch/pane-completion-protocol.ts";
import {
  ALL_PANE_BACKENDS,
  ALL_PANE_EXECUTION_MODES,
  PANE_COMPLETION_PROTOCOLS,
  buildInstructionText,
  composePanePrompt,
  resolvePaneCompletionProtocol,
  resolveOrderingSentence,
} from "../../src/launch/pane-completion-protocol.ts";

// Reference strings (byte-exact)
const CLAUDE_AUTONOMOUS_REF =
  "You are a one-shot subagent. Complete your task autonomously without " +
  "asking the user questions. When finished, " +
  "your FINAL assistant message should summarize what you accomplished, then " +
  "call `subagent_done` to end the session.";

const CLAUDE_INTERACTIVE_REF =
  "You are an interactive subagent. The user can type into this pane at " +
  "any time — feel free to ask clarifying questions as many times as " +
  "needed. When the task is complete, " +
  "your FINAL assistant message should summarize what you accomplished, then " +
  "call `subagent_done` to end the session.";

describe("PANE_COMPLETION_PROTOCOLS — runtime totality", () => {
  it("every backend × mode entry is defined with required fields", () => {
    for (const b of ALL_PANE_BACKENDS) {
      for (const m of ALL_PANE_EXECUTION_MODES) {
        const protocol = PANE_COMPLETION_PROTOCOLS[b][m];
        assert.ok(protocol, `${b}.${m} must be defined`);
        assert.equal(protocol.backend, b, `${b}.${m}.backend`);
        assert.equal(protocol.mode, m, `${b}.${m}.mode`);
        assert.ok(protocol.terminality, `${b}.${m}.terminality`);
        assert.ok(protocol.deliveryChannel, `${b}.${m}.deliveryChannel`);
        assert.ok(protocol.summaryCarrier, `${b}.${m}.summaryCarrier`);
        assert.ok(typeof protocol.framing === "string", `${b}.${m}.framing`);
        const composed = composePanePrompt({ neutralCore: "CORE", protocol });
        assert.ok(typeof composed.taskPrompt === "string", `${b}.${m} composePanePrompt.taskPrompt`);
      }
    }
  });
});

describe("resolvePaneCompletionProtocol", () => {
  it("returns task-prompt delivery for codex autonomous", () => {
    assert.equal(
      resolvePaneCompletionProtocol("codex", "autonomous").deliveryChannel,
      "task-prompt",
    );
  });

  it("throws for an unknown backend (no Claude fallthrough)", () => {
    assert.throws(() => resolvePaneCompletionProtocol("opencode" as any, "autonomous"));
  });
});

describe("buildInstructionText — Claude seam variant byte-identity", () => {
  it("autonomous matches reference string byte-for-byte", () => {
    assert.equal(buildInstructionText(PANE_COMPLETION_PROTOCOLS.claude.autonomous), CLAUDE_AUTONOMOUS_REF);
  });

  it("interactive matches reference string byte-for-byte (em-dash U+2014)", () => {
    assert.equal(buildInstructionText(PANE_COMPLETION_PROTOCOLS.claude.interactive), CLAUDE_INTERACTIVE_REF);
  });
});

describe("composePanePrompt — Codex tool-first prompt", () => {
  it("codex autonomous: tool-first, backend-neutral, no final-message-first wording", () => {
    const { taskPrompt } = composePanePrompt({
      neutralCore: "CORE",
      protocol: PANE_COMPLETION_PROTOCOLS.codex.autonomous,
    });
    assert.match(taskPrompt, /subagent_done\(message=/);
    assert.match(taskPrompt, /before sending any final answer/);
    assert.match(taskPrompt, /no further output/);
    assert.doesNotMatch(taskPrompt, /FINAL assistant message/);
    assert.doesNotMatch(taskPrompt, /summarize what you accomplished/);
    assert.doesNotMatch(taskPrompt, /In Codex/);
  });

  it("codex interactive: tool-first, contains clarifying questions, no final-message-first wording", () => {
    const { taskPrompt } = composePanePrompt({
      neutralCore: "CORE",
      protocol: PANE_COMPLETION_PROTOCOLS.codex.interactive,
    });
    assert.match(taskPrompt, /clarifying questions/);
    assert.match(taskPrompt, /subagent_done\(message=/);
    assert.match(taskPrompt, /before sending any final answer/);
    assert.match(taskPrompt, /no further output/);
    assert.doesNotMatch(taskPrompt, /FINAL assistant message/);
    assert.doesNotMatch(taskPrompt, /In Codex/);
  });
});

describe("composePanePrompt — pi native passthrough", () => {
  it("pi autonomous passes core through unchanged", () => {
    const result = composePanePrompt({
      neutralCore: "PINATIVE",
      protocol: PANE_COMPLETION_PROTOCOLS.pi.autonomous,
    });
    assert.deepEqual(result, { taskPrompt: "PINATIVE", systemPromptCompletion: null });
  });
});

describe("resolveOrderingSentence — backend-neutral derived sentence", () => {
  it("tool-first sentence contains subagent_done(message= and before sending any final answer", () => {
    const sentence = resolveOrderingSentence("tool-first", "in-band-message-arg");
    assert.match(sentence, /subagent_done\(message=/);
    assert.match(sentence, /before sending any final answer/);
    assert.doesNotMatch(sentence, /Codex/i);
  });

  it("throws for unsupported (tool-first, out-of-band-final-message)", () => {
    assert.throws(() => resolveOrderingSentence("tool-first", "out-of-band-final-message"));
  });

  it("throws for unsupported (final-message-then-tool, in-band-message-arg)", () => {
    assert.throws(() => resolveOrderingSentence("final-message-then-tool", "in-band-message-arg"));
  });
});

// Positive tie: the REAL protocol table is keyed by the launcher-visible
// PaneBackend union. If PaneBackend gains a member, this annotation fails
// (here AND at the table's own definition) until a variant is added — proving
// a new launcher-visible pane backend cannot exist without a protocol variant.
const _tableIsTotalOverPaneBackend: Record<
  PaneBackend,
  Record<PaneExecutionMode, PaneCompletionProtocol>
> = PANE_COMPLETION_PROTOCOLS;

// @ts-expect-error omitting the interactive mode must be a compile error
const _missingMode: Record<PaneExecutionMode, PaneCompletionProtocol> = {
  autonomous: PANE_COMPLETION_PROTOCOLS.codex.autonomous,
};
// @ts-expect-error a PaneBackend-keyed table missing the codex backend must be a compile error
const _missingBackend: Record<PaneBackend, Record<PaneExecutionMode, PaneCompletionProtocol>> = {
  pi: PANE_COMPLETION_PROTOCOLS.pi,
  claude: PANE_COMPLETION_PROTOCOLS.claude,
};
