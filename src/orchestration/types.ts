import type { Static } from "typebox";
import { Type } from "typebox";
import type {
  TranscriptMessage,
  UsageStats,
} from "../backends/types.ts";
import type { DiagnosticContext } from "../diagnostics/diagnostics.ts";
export type { TranscriptMessage, UsageStats };

export const OrchestrationTaskSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Widget label; auto-generated if omitted." })),
  agent: Type.String({ description: "Agent definition name." }),
  task: Type.String({ description: "Task string; may contain {previous} in serial mode." }),
  // Fields below mirror `SubagentParams`. Orchestration wrappers are thin
  // over `launchSubagent`, so keeping these in sync avoids silently reducing
  // the API surface relative to the bare `subagent` tool.
  cli: Type.Optional(Type.String({ description: "'pi' (default), 'claude', or 'codex'. Free-form string; unknown values fall back to the pi path." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String({ description: "'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'. Free-form string; unknown values are dropped on Claude and Codex, and pass through as a pi model suffix. For Codex, mapped to model_reasoning_effort; unsupported values dropped." })),
  systemPrompt: Type.Optional(Type.String({ description: "Appended (or replaces, per agent frontmatter) the system prompt for this step." })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills override for this step." })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tools override for this step." })),
  cwd: Type.Optional(Type.String()),
  fork: Type.Optional(Type.Boolean({ description: "Force full-context fork mode for this step, overriding any agent frontmatter session-mode." })),
  resumeSessionId: Type.Optional(Type.String({ description: "Resume a previous Claude Code session by ID for this step." })),
  focus: Type.Optional(Type.Boolean()),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "When true, suppress stall/recovered status steer messages for this orchestration step (the main session is not woken by transitions). Defaults follow the agent frontmatter / auto-exit chain.",
    }),
  ),
  executionPolicy: Type.Optional(
    Type.String({
      description:
        "CLI-agnostic execution policy for this step: 'guarded' (default) or 'unrestricted'. Mirrors the bare `subagent` tool; for Claude, guarded keeps the permission classifier in the loop and unrestricted restores bypass behavior. For Codex: guarded → --sandbox workspace-write with non-interactive approval_policy=never (headless) / --ask-for-approval on-request (pane); unrestricted → --dangerously-bypass-approvals-and-sandbox.",
    }),
  ),
});

export type OrchestrationTask = Static<typeof OrchestrationTaskSchema>;

export type OrchestrationState =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface OrchestrationResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
  state?: OrchestrationState;
  index?: number;
  sessionKey?: string;
  ping?: { name: string; message: string };
  /** Structured-audience diagnostic messages collected during this task's launch. */
  warnings?: string[];
}

/**
 * Per-task result on any orchestration (sync or async). Sync runs only
 * populate terminal `state` values; async runs use the full machine and
 * surface pre-terminal states (`pending`, `running`, `blocked`) in
 * intermediate completion notifications.
 */
export interface OrchestratedTaskResult {
  name: string;
  index: number;
  state: OrchestrationState;
  finalMessage?: string;
  transcriptPath?: string | null;
  elapsedMs?: number;
  exitCode?: number;
  sessionKey?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
  /** Structured-audience diagnostic messages collected during this task's launch. */
  warnings?: string[];
}

/**
 * Envelope returned immediately from `subagent_run_serial` / `subagent_run_parallel`
 * when `wait: false`. Task manifest mirrors input order with `state: "pending"`.
 */
export interface AsyncDispatchEnvelope {
  orchestrationId: string;
  tasks: Array<{ name: string; index: number; state: "pending" }>;
  isError: false;
}

/**
 * Hooks for mid-run session key delivery. Passed as the 4th positional arg to
 * `waitForCompletion` so callers can be notified as soon as a child's
 * resume-addressable key is known (before the child exits).
 */
export interface WaitForCompletionHooks {
  onSessionKey?: (sessionKey: string) => void;
}

/**
 * Dependencies that orchestration cores need injected, so tests can
 * mock all IO (pane spawning, sentinel waits, transcript reads).
 *
 * `signal` is the tool-execution AbortSignal threaded down from
 * `subagent_run_serial` / `subagent_run_parallel`. `waitForCompletion` must
 * observe it so user-initiated cancellation of the tool call aborts
 * the running subagent's poll loop and frees its pane. `launch`
 * accepts the signal symmetrically for future use (e.g. surface
 * creation that honors cancellation).
 */
export interface LauncherDeps {
  launch(
    task: OrchestrationTask,
    defaultFocus: boolean,
    signal?: AbortSignal,
    diagnostics?: DiagnosticContext,
  ): Promise<LaunchedHandle>;
  waitForCompletion(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onUpdate?: (partial: OrchestrationResult) => void,
    hooks?: WaitForCompletionHooks,
  ): Promise<OrchestrationResult>;
}

export interface LaunchedHandle {
  id: string;
  name: string;
  startTime: number;
  /**
   * Resume-addressable identifier for this child. Same value the parent
   * will pass back through `subagent_resume({ sessionPath })` for pi-backed
   * children, or the Claude session id for Claude-backed children. Used to
   * key the orchestration registry's ownership map.
   */
  sessionKey?: string;
  /** Pi children only — path to the child-written activity-snapshot JSON file. */
  activityFile?: string;
}

export const MAX_PARALLEL_HARD_CAP = 8;
export const DEFAULT_PARALLEL_CONCURRENCY = 4;
