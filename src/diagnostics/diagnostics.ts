/** Audience set: independently routes the same diagnostic to channels. */
export interface DiagnosticAudience {
  /** Human channel: UI notify when an active UI exists, else stderr. */
  human?: boolean;
  /** Structured channel: pushed to a tool-call collector when one is present. */
  structured?: boolean;
}

/** Stable, internal-only category code (NOT exposed in the tool payload). */
export type DiagnosticCode =
  | "skills-dropped"
  | "tools-dropped"
  | "guarded-policy-unsupported"
  | "codex-system-prompt-replace"
  | "invalid-subagent-mode";

export interface Diagnostic {
  code: DiagnosticCode;
  /** Exact human-facing text, including any trailing newline the stderr path expects. */
  message: string;
  audience: DiagnosticAudience;
}

/** Minimal UI shape the dispatcher needs; structurally a subset of ExtensionContext. */
export interface AmbientUiContext {
  hasUI: boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** Per-tool-call structured sink. */
export interface DiagnosticCollector {
  push(d: Diagnostic): void;
  /** Return collected diagnostic messages byte-for-byte (the exact `message`, including any trailing newline) and clear. */
  drain(): string[];
}

/** Context threaded into the dispatcher. Only the structured collector varies per call. */
export interface DiagnosticContext {
  collector?: DiagnosticCollector;
}

export function createDiagnosticCollector(): DiagnosticCollector {
  const items: Diagnostic[] = [];
  return {
    push(d) { items.push(d); },
    drain() {
      // Byte-for-byte: store and return the diagnostic's exact `message`
      // (including the trailing newline). The spec freezes the producer string
      // and requires the same string mirrored into details.warnings — do NOT trim.
      const out = items.map((d) => d.message);
      items.length = 0;
      return out;
    },
  };
}

let ambientUiResolver: () => AmbientUiContext | null = () => null;

/** Register the live UI source. index.ts passes `() => latestCtx`. */
export function registerAmbientUi(resolver: () => AmbientUiContext | null): void {
  ambientUiResolver = resolver;
}

/**
 * The single delivery decision point. No other site may branch between
 * ui.notify, structured metadata, and process.stderr.write.
 */
export function emitDiagnostic(diagnostic: Diagnostic, context?: DiagnosticContext): void {
  if (diagnostic.audience.human) {
    const ui = ambientUiResolver();
    if (ui?.hasUI) ui.ui.notify(diagnostic.message.replace(/\n+$/, ""), "warning");
    else process.stderr.write(diagnostic.message);
  }
  if (diagnostic.audience.structured) {
    context?.collector?.push(diagnostic);
  }
}

export const __test__ = {
  /** Capture the current resolver so a test can restore it (avoids cross-file contamination). */
  getAmbientUi(): () => AmbientUiContext | null { return ambientUiResolver; },
  setAmbientUi(resolver: () => AmbientUiContext | null): void { ambientUiResolver = resolver; },
};
