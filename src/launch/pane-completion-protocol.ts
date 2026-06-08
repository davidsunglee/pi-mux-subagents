/**
 * Pane completion-protocol seam.
 *
 * Every pane CLI backend (pi, Claude, Codex) declares how it signals task
 * completion to the model. This seam is total over backend × execution-mode
 * and the totality is enforced at COMPILE TIME (see PANE_COMPLETION_PROTOCOLS
 * and the exhaustiveness guards below): adding a backend or a mode without an
 * explicit variant is a `tsc` error, so no backend can silently inherit
 * another's completion semantics.
 *
 * The shared composer (composePanePrompt) assembles a pane backend's launch
 * prompt from a neutral core (identity + task, free of completion wording)
 * plus the backend's completion contribution, in one canonical order. The
 * ordering SENTENCE (tool-first vs final-message-then-tool) is DERIVED from
 * each backend's declared `terminality` — it is never hand-authored per
 * backend.
 */

export type PaneBackend = "pi" | "claude" | "codex";
export type PaneExecutionMode = "autonomous" | "interactive";

/**
 * Whether emitting a final assistant answer can END the model's turn.
 * - "final-answer-terminal": a final answer may end the turn (Codex) →
 *   TOOL-FIRST ordering posture.
 * - "final-answer-nonterminal": the model keeps control after a final answer
 *   (Claude, pi) → FINAL-MESSAGE-THEN-TOOL ordering posture.
 */
export type Terminality = "final-answer-terminal" | "final-answer-nonterminal";

export type CompletionDeliveryChannel =
  | "system-prompt" // Claude — folded into --append-system-prompt
  | "task-prompt" // Codex — appended to the pane task prompt
  | "native-extension"; // pi — driven by the subagent-done.ts extension

export type SummaryCarrier =
  | "in-band-message-arg" // subagent_done(message=…)
  | "out-of-band-final-message"; // trailing assistant message

export type OrderingPosture = "tool-first" | "final-message-then-tool";

export interface PaneCompletionProtocol {
  backend: PaneBackend;
  mode: PaneExecutionMode;
  terminality: Terminality;
  deliveryChannel: CompletionDeliveryChannel;
  summaryCarrier: SummaryCarrier;
  /**
   * Per-mode framing text, MINUS the ordering sentence. The composer appends
   * the derived ordering sentence (resolveOrderingSentence). End this string
   * WITHOUT a trailing space; the composer joins with a single space.
   */
  framing: string;
}

/** Ordering posture is a pure function of terminality. */
export function deriveOrderingPosture(t: Terminality): OrderingPosture {
  return t === "final-answer-terminal" ? "tool-first" : "final-message-then-tool";
}

/**
 * The ordering sentence is DERIVED from (posture, summary carrier); it is never
 * hand-authored per backend and carries NO backend name, so a future backend
 * that declares the same (posture, carrier) inherits correct — not Codex-named
 * — wording. Each SUPPORTED combination has its own explicit branch; an
 * unsupported (posture, carrier) pair THROWS so a new pairing fails visibly
 * instead of silently borrowing another backend's sentence (the same
 * no-silent-inheritance guarantee the compile-time table gives the slots).
 */
export function resolveOrderingSentence(
  posture: OrderingPosture,
  carrier: SummaryCarrier,
): string {
  if (posture === "tool-first" && carrier === "in-band-message-arg") {
    // Backend-neutral: for ANY terminal-final-answer backend a final answer can
    // end the turn, so the tool call — not the final answer — is the signal.
    // (Used by Codex today; no backend name appears in the wording.)
    return (
      "A final answer can end your turn, so a final answer is NOT the completion " +
      "signal: call `subagent_done(message=…)` with your full summary in the " +
      "`message` argument before sending any final answer, and send no further " +
      "output after that call."
    );
  }
  if (
    posture === "final-message-then-tool" &&
    carrier === "out-of-band-final-message"
  ) {
    // Byte-identical to the legacy buildClaudeCompletionAddendum tail (Claude, pi).
    return (
      "your FINAL assistant message should summarize what you accomplished, then " +
      "call `subagent_done` to end the session."
    );
  }
  // No default fallthrough: an unsupported (posture, carrier) combination must
  // fail visibly rather than inherit another backend's wording.
  throw new Error(
    `resolveOrderingSentence: unsupported (posture=${posture}, carrier=${carrier}); ` +
      "add an explicit ordering sentence for this combination before using it.",
  );
}

/** Build the full per-mode instruction (framing + derived ordering sentence). */
export function buildInstructionText(p: PaneCompletionProtocol): string {
  const sentence = resolveOrderingSentence(
    deriveOrderingPosture(p.terminality),
    p.summaryCarrier,
  );
  return p.framing ? `${p.framing} ${sentence}` : sentence;
}

export interface ComposedPanePrompt {
  /** Task-prompt text for the pane CLI's prompt argument. */
  taskPrompt: string;
  /** Completion text for the system prompt, or null when N/A. */
  systemPromptCompletion: string | null;
}

function joinCore(core: string, trailing: string): string {
  return core.trim().length > 0 ? `${core}\n\n${trailing}` : trailing;
}

/**
 * Single shared composer. Joins the neutral core with the backend's
 * completion contribution in one canonical order (core, then trailing
 * completion for the task-prompt channel). Callers pass a neutral core and a
 * protocol and read the field for their delivery channel — no per-backend
 * branching at the call site.
 */
export function composePanePrompt(input: {
  neutralCore: string;
  protocol: PaneCompletionProtocol;
}): ComposedPanePrompt {
  const { neutralCore, protocol } = input;
  const instruction = buildInstructionText(protocol);
  switch (protocol.deliveryChannel) {
    case "task-prompt":
      return { taskPrompt: joinCore(neutralCore, instruction), systemPromptCompletion: null };
    case "system-prompt":
      return { taskPrompt: neutralCore, systemPromptCompletion: instruction };
    case "native-extension":
      // pi delivers completion via its native extension; the composer adds no
      // prompt text and passes the core through unchanged.
      return { taskPrompt: neutralCore, systemPromptCompletion: null };
  }
}

/**
 * Total over PaneBackend × PaneExecutionMode. The mapped type makes a missing
 * backend OR a missing mode a `tsc` error (requirement: no silent inheritance).
 */
export const PANE_COMPLETION_PROTOCOLS: {
  readonly [B in PaneBackend]: { readonly [M in PaneExecutionMode]: PaneCompletionProtocol };
} = {
  pi: {
    autonomous: {
      backend: "pi", mode: "autonomous",
      terminality: "final-answer-nonterminal",
      deliveryChannel: "native-extension",
      summaryCarrier: "out-of-band-final-message",
      framing:
        "You are a one-shot subagent. Complete your task autonomously without " +
        "asking the user questions. When finished,",
    },
    interactive: {
      backend: "pi", mode: "interactive",
      terminality: "final-answer-nonterminal",
      deliveryChannel: "native-extension",
      summaryCarrier: "out-of-band-final-message",
      framing:
        "You are an interactive subagent. The user can interact with you at any " +
        "time. When the task is complete,",
    },
  },
  claude: {
    autonomous: {
      backend: "claude", mode: "autonomous",
      terminality: "final-answer-nonterminal",
      deliveryChannel: "system-prompt",
      summaryCarrier: "out-of-band-final-message",
      framing:
        "You are a one-shot subagent. Complete your task autonomously without " +
        "asking the user questions. When finished,",
    },
    interactive: {
      backend: "claude", mode: "interactive",
      terminality: "final-answer-nonterminal",
      deliveryChannel: "system-prompt",
      summaryCarrier: "out-of-band-final-message",
      framing:
        "You are an interactive subagent. The user can type into this pane at " +
        "any time — feel free to ask clarifying questions as many times as " +
        "needed. When the task is complete,",
    },
  },
  codex: {
    autonomous: {
      backend: "codex", mode: "autonomous",
      terminality: "final-answer-terminal",
      deliveryChannel: "task-prompt",
      summaryCarrier: "in-band-message-arg",
      framing:
        "You are a one-shot subagent. Complete your task autonomously without " +
        "asking the user questions.",
    },
    interactive: {
      backend: "codex", mode: "interactive",
      terminality: "final-answer-terminal",
      deliveryChannel: "task-prompt",
      summaryCarrier: "in-band-message-arg",
      framing:
        "You are an interactive subagent. You may ask the user clarifying " +
        "questions at any time.",
    },
  },
};

export function resolvePaneCompletionProtocol(
  backend: PaneBackend,
  mode: PaneExecutionMode,
): PaneCompletionProtocol {
  // Direct typed lookup — NO default branch, so an unknown backend cannot
  // silently inherit Claude (or any other) semantics.
  return PANE_COMPLETION_PROTOCOLS[backend][mode];
}

export const ALL_PANE_BACKENDS = ["pi", "claude", "codex"] as const;
export const ALL_PANE_EXECUTION_MODES = ["autonomous", "interactive"] as const;

// Compile-time totality guards: if a union gains a member not present in the
// tuple, the guard type becomes `never` and the `= true` assignment fails tsc.
type _BackendsExhaustive =
  Exclude<PaneBackend, (typeof ALL_PANE_BACKENDS)[number]> extends never ? true : never;
type _ModesExhaustive =
  Exclude<PaneExecutionMode, (typeof ALL_PANE_EXECUTION_MODES)[number]> extends never ? true : never;
const _backendsCheck: _BackendsExhaustive = true;
const _modesCheck: _ModesExhaustive = true;

/**
 * Exhaustiveness guard for the launcher's pane-backend DISPATCH. The pane
 * launch selection in index.ts switches on the finite `spec.paneBackend`
 * (ResolvedLaunchSpec.paneBackend, projected from effectiveCli) and ends with
 * `return assertNever(spec.paneBackend)`. Because that dispatch AND
 * PANE_COMPLETION_PROTOCOLS are keyed on the SAME PaneBackend union, adding a
 * pane backend fails to compile in BOTH places — they cannot diverge.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled pane backend: ${String(x)}`);
}
