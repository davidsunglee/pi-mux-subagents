import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getSubagentActivityFile } from "../launch/activity.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LineBuffer } from "./line-buffer.ts";
import {
  resolveLaunchSpec,
  resolvePiToolsArg,
  warnGuardedPolicyUnsupported,
  writeSystemPromptArtifact,
  writeTaskArtifact,
  type ResolvedLaunchSpec,
} from "../launch/launch-spec.ts";
import { seedSubagentSessionFile } from "../launch/session.ts";
import { buildClaudeHeadlessArgs, parseClaudeStreamEvent, parseClaudeResult } from "./claude-stream.ts";
import { buildCodexExecArgs, parseCodexEvent, parseCodexUsage, extractCodexSessionId, parseCodexError } from "./codex-stream.ts";
import { warnClaudeSkillsDropped, warnCodexUnsupportedFeatures } from "../index.ts";
import type { DiagnosticContext } from "../diagnostics/diagnostics.ts";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  BackendWatchHooks,
  LaunchedHandle,
  TranscriptMessage,
  UsageStats,
} from "./types.ts";
import { projectPiMessageToTranscript, type PiStreamMessage } from "./pi-projection.ts";
export { projectPiMessageToTranscript, type PiStreamMessage } from "./pi-projection.ts";

interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  abort: AbortController;
  /**
   * Most recent partial snapshot emitted by the runner (pi/Claude path or an
   * injected test runner). Buffered so `watch()` can replay the latest partial
   * immediately to a late-bound `onUpdate`. The invariant: headless work
   * starts inside `launch()`, so partials may fire before `watch()` attaches —
   * we must not drop them.
   */
  latestPartial?: BackendResult;
  /**
   * `watch()` installs this once it attaches. `emitPartial()` calls it (if
   * present) with a fresh clone of the snapshot. Unset before attachment;
   * partials are still buffered via `latestPartial`.
   */
  onUpdate?: (p: BackendResult) => void;
}

// Module-private spawn reference that the unit test harness can swap out.
// Using a let-binding allows node:test to inject a fake spawn without
// rewriting `node:child_process` (which is frozen on ESM import).
let spawnImpl: typeof realSpawn = realSpawn;

function emitPartial(entry: HeadlessLaunch, snapshot: BackendResult): void {
  entry.latestPartial = { ...snapshot };
  entry.onUpdate?.({ ...entry.latestPartial });
}

export const __test__ = {
  setSpawn(fn: typeof realSpawn): void { spawnImpl = fn; },
  restoreSpawn(): void { spawnImpl = realSpawn; },
  /**
   * Build a headless Backend whose pi/Claude runners are replaced by the
   * injected `runner`. Used by unit tests to drive deterministic
   * emit/finish sequences without spawning real processes.
   *
   * The `emitPartial` passed to the runner closes over the launch entry
   * created inside `launch()`, so partials flow through the same buffer +
   * late-bound `onUpdate` path as production runners.
   */
  makeHeadlessBackendWithRunner(
    ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string },
    runner: (args: {
      spec: BackendLaunchParams;
      startTime: number;
      abort: AbortSignal;
      emitPartial: (snapshot: BackendResult) => void;
    }) => Promise<BackendResult>,
  ): Backend {
    const launches = new Map<string, HeadlessLaunch>();
    return {
      async launch(
        params: BackendLaunchParams,
        _defaultFocus: boolean,
        signal?: AbortSignal,
      ): Promise<LaunchedHandle> {
        const id = Math.random().toString(16).slice(2, 10);
        const startTime = Date.now();
        const abort = new AbortController();
        if (signal) {
          if (signal.aborted) abort.abort();
          else signal.addEventListener("abort", () => abort.abort(), { once: true });
        }
        const name = params.name ?? "subagent";
        const entry: HeadlessLaunch = {
          id,
          name,
          startTime,
          promise: Promise.resolve<BackendResult>(null as any),
          abort,
        };
        entry.promise = runner({
          spec: params,
          startTime,
          abort: abort.signal,
          emitPartial: (snap) => emitPartial(entry, snap),
        });
        launches.set(id, entry);
        return { id, name, startTime };
      },
      async watch(
        handle: LaunchedHandle,
        watchSignal?: AbortSignal,
        onUpdate?: (partial: BackendResult) => void,
      ): Promise<BackendResult> {
        const entry = launches.get(handle.id);
        if (!entry) {
          return {
            name: handle.name,
            finalMessage: "",
            transcriptPath: null,
            exitCode: 1,
            elapsedMs: 0,
            error: `no launch entry for ${handle.id}`,
          };
        }
        try {
          if (watchSignal) {
            if (watchSignal.aborted) entry.abort.abort();
            else watchSignal.addEventListener("abort", () => entry.abort.abort(), { once: true });
          }
          entry.onUpdate = onUpdate;
          if (entry.latestPartial && onUpdate) {
            onUpdate({ ...entry.latestPartial });
          }
          return await entry.promise;
        } finally {
          launches.delete(handle.id);
        }
      },
    };
  },
};

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(transcript: TranscriptMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function makeHeadlessBackend(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  const launches = new Map<string, HeadlessLaunch>();

  return {
    async launch(
      params: BackendLaunchParams,
      _defaultFocus: boolean,
      signal?: AbortSignal,
      diagnostics?: DiagnosticContext,
    ): Promise<LaunchedHandle> {
      const id = Math.random().toString(16).slice(2, 10);
      const startTime = Date.now();
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const spec = resolveLaunchSpec(
        {
          name: params.name ?? "subagent",
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          systemPrompt: params.systemPrompt,
          skills: params.skills,
          tools: params.tools,
          cwd: params.cwd,
          fork: params.fork,
          resumeSessionId: params.resumeSessionId,
          cli: params.cli,
          focus: params.focus,
          executionPolicy: params.executionPolicy,
        },
        ctx,
      );
      warnGuardedPolicyUnsupported(spec, diagnostics);

      const entry: HeadlessLaunch = {
        id,
        name: spec.name,
        startTime,
        promise: Promise.resolve<BackendResult>(null as any),
        abort,
      };
      const emit = (snap: BackendResult): void => emitPartial(entry, snap);
      // Unknown/typo cli values are documented to fall back to the pi path
      // (see OrchestrationTaskSchema.cli), so they must carry pi session/activity
      // metadata too. Only Claude and Codex own the late-bound metadata path.
      const isPiLike = isPiLikeCli(spec.effectiveCli);
      let piActivityFile: string | undefined;
      if (isPiLike) {
        piActivityFile = getSubagentActivityFile(spec.artifactDir, id);
        mkdirSync(dirname(piActivityFile), { recursive: true });
      }

      entry.promise =
        spec.effectiveCli === "claude"
          ? runClaudeHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit, diagnostics })
          : spec.effectiveCli === "codex"
            ? runCodexHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit, diagnostics })
            : runPiHeadless({ id, spec, startTime, abort: abort.signal, ctx, emitPartial: emit, diagnostics });

      launches.set(id, entry);
      return {
        id,
        name: spec.name,
        startTime,
        // Pi children: session file is known at launch.
        // Claude/Codex children: session key is late-bound (Claude via onSessionKey
        // hook; Codex via the JSONL thread.started event), so it is omitted here.
        ...(isPiLike ? { sessionKey: spec.subagentSessionFile, activityFile: piActivityFile } : {}),
      };
    },

    async watch(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: BackendResult) => void,
      hooks?: BackendWatchHooks,
    ): Promise<BackendResult> {
      const entry = launches.get(handle.id);
      if (!entry) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: `no launch entry for ${handle.id}`,
        };
      }
      // Pi children: fire onSessionKey immediately (session file known at launch).
      // The sessionKey was stored on the LaunchedHandle so we can retrieve it here.
      if (handle.sessionKey) {
        try { hooks?.onSessionKey?.(handle.sessionKey); } catch { /* defensive */ }
      }
      try {
        if (signal) {
          if (signal.aborted) entry.abort.abort();
          else signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
        }
        entry.onUpdate = onUpdate;
        if (entry.latestPartial && onUpdate) {
          onUpdate({ ...entry.latestPartial });
        }
        return await entry.promise;
      } finally {
        launches.delete(handle.id);
      }
    },
  };
}

/**
 * Whether a resolved cli routes through the pi headless runner. `claude` and
 * `codex` own dedicated runners with late-bound session/activity metadata;
 * every other value (including unknown/typo cli strings) falls back to pi per
 * the documented OrchestrationTaskSchema.cli contract, so it must carry the
 * pi session key and activity file.
 */
function isPiLikeCli(effectiveCli: string): boolean {
  return effectiveCli !== "claude" && effectiveCli !== "codex";
}

interface RunParams {
  id: string;
  spec: ResolvedLaunchSpec;
  startTime: number;
  abort: AbortSignal;
  ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string };
  emitPartial: (snapshot: BackendResult) => void;
  diagnostics?: DiagnosticContext;
}

function makeAbortHandler(proc: ChildProcess, isExited: () => boolean): () => void {
  return () => {
    try { proc.kill("SIGTERM"); } catch {}
    // Do not keep the event loop open after the child exits normally.
    setTimeout(() => {
      if (!isExited()) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }, 5000).unref();
  };
}


async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { id, spec, startTime, abort, ctx, emitPartial: emit } = p;
  const transcript: TranscriptMessage[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let terminalEvent = false;

  const activityFile = getSubagentActivityFile(spec.artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  if (spec.seededSessionMode) {
    seedSubagentSessionFile({
      mode: spec.seededSessionMode,
      parentSessionFile: ctx.sessionManager.getSessionFile()!,
      childSessionFile: spec.subagentSessionFile,
      childCwd: spec.effectiveCwd ?? ctx.cwd,
    });
  }

  const systemPromptFlag: string[] = [];
  if (spec.identityInSystemPrompt && spec.identity) {
    const flag = spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const artifactPath = writeSystemPromptArtifact(spec);
    if (artifactPath) systemPromptFlag.push(flag, artifactPath);
  }

  const subagentDonePath = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "tools",
    "subagent-done.ts",
  );

  // pi's non-interactive JSON stream is `--mode json --print` in the installed
  // CLI surface (no `--output-format` flag). `--print` / `-p` makes pi
  // non-interactive; `--mode json` emits one JSON event per line on stdout.
  const args: string[] = [
    "--session", spec.subagentSessionFile,
    "-e", subagentDonePath,
    "--mode", "json",
    "--print",
  ];
  if (spec.effectiveModel) {
    const model = spec.effectiveThinking
      ? `${spec.effectiveModel}:${spec.effectiveThinking}`
      : spec.effectiveModel;
    args.push("--model", model);
  }
  args.push(...systemPromptFlag);
  const toolsArg = resolvePiToolsArg(spec.effectiveTools);
  if (toolsArg) args.push("--tools", toolsArg);

  let taskArg: string;
  if (spec.taskDelivery === "direct") {
    taskArg = spec.fullTask;
  } else {
    taskArg = `@${writeTaskArtifact(spec)}`;
  }
  const positional: string[] = [];
  if (spec.taskDelivery === "artifact" && spec.skillPrompts.length > 0) {
    positional.push("");
  }
  positional.push(...spec.skillPrompts, taskArg);
  args.push(...positional);

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    PI_SUBAGENT_NAME: spec.name,
    PI_SUBAGENT_SESSION: spec.subagentSessionFile,
    PI_SUBAGENT_ID: id,
    PI_SUBAGENT_ACTIVITY_FILE: activityFile,
    ...spec.configRootEnv,
  };
  if (spec.agent) childEnv.PI_SUBAGENT_AGENT = spec.agent;
  if (spec.autoExit) childEnv.PI_SUBAGENT_AUTO_EXIT = "1";
  if (spec.denySet.size > 0) childEnv.PI_DENY_TOOLS = [...spec.denySet].join(",");
  else delete childEnv.PI_DENY_TOOLS;

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl("pi", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err: any) {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;          // ← set ONLY by close/exit; drives SIGKILL escalation
    proc.on("exit", () => { exited = true; });

    const emitSnapshot = () => {
      emit({
        name: spec.name,
        finalMessage: getFinalOutput(transcript),
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: Date.now() - startTime,
        usage,
        transcript,
      });
    };

    const seenAssistantStableKeys = new Set<string>();
    const assistantStableKeys = (msg: PiStreamMessage): string[] => {
      const anyMsg = msg as any;
      const contentKey = JSON.stringify(msg.content ?? []);
      const keys: string[] = [];
      if (anyMsg.responseId) keys.push(`response:${anyMsg.responseId}`);
      if (anyMsg.timestamp) keys.push(`timestamp:${anyMsg.timestamp}:content:${contentKey}`);
      return keys;
    };
    const assistantTerminalFallbackKey = (msg: PiStreamMessage): string => {
      const anyMsg = msg as any;
      return `content:${JSON.stringify(msg.content ?? [])}:stop:${anyMsg.stopReason ?? ""}`;
    };
    const recordedAssistantTerminalFallbackKeys: string[] = [];
    let lastAssistantTerminalFallbackKey: string | undefined;

    const recordPiMessage = (
      msg: PiStreamMessage,
      shouldEmit: boolean,
      source: "message_end" | "tool_result_end" | "turn_end" | "agent_end",
    ): void => {
      let assistantTerminalKey: string | undefined;
      if (msg.role === "assistant") {
        const stableKeys = assistantStableKeys(msg);
        const seenStable = stableKeys.some((key) => seenAssistantStableKeys.has(key));
        assistantTerminalKey = assistantTerminalFallbackKey(msg);
        const seenTerminalCopy = source === "turn_end"
          && assistantTerminalKey === lastAssistantTerminalFallbackKey;
        if (seenStable || seenTerminalCopy) return;
        for (const key of stableKeys) seenAssistantStableKeys.add(key);
        lastAssistantTerminalFallbackKey = assistantTerminalKey;
      }

      transcript.push(projectPiMessageToTranscript(msg));
      if (msg.role === "assistant" && assistantTerminalKey) {
        recordedAssistantTerminalFallbackKeys.push(assistantTerminalKey);
      }
      if (msg.role === "assistant") {
        usage.turns++;
        const u: any = (msg as any).usage;
        if (u) {
          usage.input += u.input ?? 0;
          usage.output += u.output ?? 0;
          usage.cacheRead += u.cacheRead ?? 0;
          usage.cacheWrite += u.cacheWrite ?? 0;
          usage.cost += u.cost?.total ?? 0;
          usage.contextTokens = u.totalTokens ?? usage.contextTokens;
        }
        const stop = (msg as any).stopReason;
        if (stop === "endTurn" || stop === "stop" || stop === "error") terminalEvent = true;
      }
      if (shouldEmit) emitSnapshot();
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_end" && event.message) {
        // Emit a partial snapshot on each message_end (not on every delta line,
        // which would spam). Reflects accumulated transcript + usage so far.
        recordPiMessage(event.message as PiStreamMessage, true, "message_end");
      } else if (event.type === "tool_result_end" && event.message) {
        recordPiMessage(event.message as PiStreamMessage, false, "tool_result_end");
      } else if (event.type === "turn_end" && event.message) {
        // `turn_end` is a terminal stream event from pi. Normally the preceding
        // assistant message_end carries the same message; recordPiMessage
        // deduplicates by response id and therefore acts as a race-closer when
        // message_end was missed.
        terminalEvent = true;
        recordPiMessage(event.message as PiStreamMessage, true, "turn_end");
      } else if (event.type === "agent_end") {
        // Headless completion should not depend on seeing every message_end
        // line. Under load, the process can still emit agent_end with the final
        // messages before close; use it as the authoritative terminal event and
        // backfill any assistant messages the live stream missed.
        terminalEvent = true;
        if (Array.isArray(event.messages)) {
          const assistantMessages = (event.messages as PiStreamMessage[])
            .filter((msg) => msg.role === "assistant");
          const terminalKeys = assistantMessages.map(assistantTerminalFallbackKey);
          const maxOverlap = Math.min(recordedAssistantTerminalFallbackKeys.length, terminalKeys.length);
          let overlap = 0;
          for (let size = maxOverlap; size > 0; size--) {
            let matches = true;
            for (let i = 0; i < size; i++) {
              if (recordedAssistantTerminalFallbackKeys[recordedAssistantTerminalFallbackKeys.length - size + i] !== terminalKeys[i]) {
                matches = false;
                break;
              }
            }
            if (matches) {
              overlap = size;
              break;
            }
          }
          for (const msg of assistantMessages.slice(overlap)) {
            recordPiMessage(msg, true, "agent_end");
          }
        }
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        sessionKey: spec.subagentSessionFile,
        error: err.code === "ENOENT"
          ? "pi CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", (code) => {
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const archived = existsSync(spec.subagentSessionFile) ? spec.subagentSessionFile : null;
      const exitCode = code ?? 0;
      const final = getFinalOutput(transcript);
      const sessionKey = spec.subagentSessionFile;

      // Check for .exit sidecar file written by subagent_done / caller_ping.
      // This sidecar may be present if the pi child exited via the headless path
      // (e.g. in tests or when running without a pane). The pane path uses
      // pollForExit which already consumes the sidecar; the headless path does
      // not, so we check here.
      let ping: { name: string; message: string } | undefined;
      try {
        const exitFile = `${spec.subagentSessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          if (data.type === "ping") {
            ping = { name: data.name, message: data.message };
          }
        }
      } catch { /* ignore malformed sidecar */ }

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs, error: "aborted", sessionKey, usage, transcript });
        return;
      }
      if (exitCode !== 0) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode, elapsedMs,
                  error: stderr.trim() || `pi exited with code ${exitCode}`,
                  sessionKey, usage, transcript });
        return;
      }
      if (ping) {
        // Ping: subagent is blocked and requesting help. Resolve with ping info.
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 0, elapsedMs, sessionKey, ping, usage, transcript });
        return;
      }
      if (!terminalEvent) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs,
                  error: "child exited without completion event", sessionKey, usage, transcript });
        return;
      }
      resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                exitCode: 0, elapsedMs, sessionKey, usage, transcript });
    });
  });
}

// Claude CLI children cannot call pi's `caller_ping` tool; that extension is
// only loaded inside pi children. This runner therefore never populates
// `BackendResult.ping`, and Claude async orchestration tasks run to terminal.
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx, emitPartial: emit } = p;
  const transcript: TranscriptMessage[] = [];
  let usage: UsageStats = emptyUsage();
  let hasRealUsage = false;
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  warnClaudeSkillsDropped(spec.name, spec.effectiveSkills, p.diagnostics);

  // Claude always uses direct task delivery — the Claude CLI prompt argument does
  // not support @file substitution, so spec.taskDelivery is ignored on this path.
  const taskText = spec.claudeTaskBody;

  const args = buildClaudeHeadlessArgs(spec, taskText);

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl("claude", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spec.configRootEnv },
      });
    } catch (err: any) {
      resolve({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;
    // Guard against double-resolve if both `error` and `close` fire.
    let settled = false;
    const settle = (r: BackendResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init"
          && typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "result") {
        terminalResult = parseClaudeResult(event);
        usage = terminalResult.usage;
        hasRealUsage = true;
        // Terminal result event — emit a snapshot reflecting final usage and
        // final message. The `close` handler will still emit the ultimate
        // resolved BackendResult; this gives watchers a usage-complete partial
        // before archival.
        emit({
          name: spec.name,
          finalMessage: terminalResult.finalOutput ?? "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: Date.now() - startTime,
          sessionId,
          ...(hasRealUsage ? { usage } : {}),
          transcript,
        });
      } else {
        const msgs = parseClaudeStreamEvent(event);
        if (msgs) {
          let sawAssistant = false;
          for (const m of msgs) {
            transcript.push(m);
            if (m.role === "assistant") sawAssistant = true;
          }
          if (sawAssistant) {
            usage.turns += 1;
            hasRealUsage = true;
            // Emit a partial on assistant events (not on every tool-result
            // fragment or user message, which would spam).
            emit({
              name: spec.name,
              finalMessage: getFinalOutput(transcript),
              transcriptPath: null,
              exitCode: 0,
              elapsedMs: Date.now() - startTime,
              sessionId,
              ...(hasRealUsage ? { usage: { ...usage } } : {}),
              transcript,
            });
          }
        }
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "claude CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", async (code) => {
      if (settled) return;
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const exitCode = code ?? 0;
      const finalMessage = terminalResult?.finalOutput ?? "";
      // Warn if a clean stream ended without system/init; Claude's stream
      // format may have changed.
      if (!sessionId && exitCode === 0) {
        process.stderr.write(
          `[pi-interactive-subagent] ${spec.name}: no system/init event seen — ` +
            `transcriptPath will be null (Claude stream format may have changed)\n`,
        );
      }
      // Archival may throw (EACCES, ENOSPC, race vs. session deletion). Fall
      // through to transcriptPath=null instead of rejecting the close handler.
      let transcriptPath: string | null = null;
      if (sessionId) {
        try {
          transcriptPath = await archiveClaudeTranscript(sessionId);
        } catch (e: any) {
          process.stderr.write(
            `[pi-interactive-subagent] transcript archive failed: ${e?.message ?? e}\n`,
          );
        }
      }

      if (wasAborted) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "aborted", sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        settle({ name: spec.name, finalMessage, transcriptPath,
                  exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
                  error: terminalResult?.error
                    ?? (stderr.trim() || `claude exited with code ${exitCode}`),
                  sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      if (!terminalResult) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "child exited without completion event",
                  sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, sessionKey: sessionId, usage, transcript });
    });
  });
}

// Codex CLI children run `codex exec --json` and deliver the prompt via stdin.
// Like the Claude path, they cannot call pi's `caller_ping` tool, so this runner
// never populates `BackendResult.ping`. The JSONL stream is teed to an archive
// file under ~/.pi/agent/sessions/codex-cli/ for later inspection.
async function runCodexHeadless(p: RunParams): Promise<BackendResult> {
  const { id, spec, startTime, abort, ctx, emitPartial: emit } = p;
  const transcript: TranscriptMessage[] = [];
  const usage: UsageStats = emptyUsage();
  let hasRealUsage = false;
  let stderr = "";
  let sessionId: string | undefined;
  let sawTerminal = false;
  // Structured failure message parsed from JSONL `error` / `turn.failed` events.
  // Preferred over benign stderr (e.g. "Reading prompt from stdin...") when the
  // child exits non-zero so the real model/API/config failure is not masked.
  let structuredError: string | undefined;
  const rawLines: string[] = []; // teed JSONL for archival

  warnCodexUnsupportedFeatures(spec.name, spec.effectiveSkills, spec.effectiveTools, spec.systemPromptMode, p.diagnostics);

  const cwd = spec.effectiveCwd ?? ctx.cwd;
  const outFile = join(spec.artifactDir, "codex", `${id}-last-message.txt`);
  mkdirSync(dirname(outFile), { recursive: true });
  const args = buildCodexExecArgs(spec, { outputLastMessageFile: outFile, cwd });

  // Resume requires a session id; if resumeSessionId is an empty string, fail
  // deterministically rather than spawning a `codex exec resume` with no id.
  if (spec.resumeSessionId !== undefined && spec.resumeSessionId.trim() === "") {
    return {
      name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
      elapsedMs: Date.now() - startTime,
      error: "codex resume requested without a session id",
    };
  }

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl("codex", args, {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...spec.configRootEnv },
      });
    } catch (err: any) {
      resolve({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    // Deliver the prompt via stdin. spec.fullTask carries the identity roleBlock
    // — Codex declares "no system-prompt channel" in the identity-delivery seam
    // (identity-delivery.ts), so resolveLaunchSpec keeps identityInSystemPrompt
    // false for Codex and the identity ALWAYS rides the prompt body here, even
    // when the agent sets system-prompt: append|replace.
    try {
      proc.stdin!.write(spec.fullTask);
      proc.stdin!.end();
    } catch { /* stdin may already be closed on a failed spawn */ }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;
    // Guard against double-resolve if both `error` and `close` fire.
    let settled = false;
    const settle = (r: BackendResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      rawLines.push(line);
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      const sid = extractCodexSessionId(event);
      if (sid) sessionId = sid;

      const msgs = parseCodexEvent(event);
      if (msgs) {
        let sawAssistant = false;
        for (const m of msgs) {
          transcript.push(m);
          if (m.role === "assistant") sawAssistant = true;
        }
        if (sawAssistant) {
          usage.turns += 1;
          hasRealUsage = true;
          // Emit a partial on assistant events (not on every fragment).
          emit({
            name: spec.name,
            finalMessage: getFinalOutput(transcript),
            transcriptPath: null,
            exitCode: 0,
            elapsedMs: Date.now() - startTime,
            sessionId,
            ...(hasRealUsage ? { usage: { ...usage } } : {}),
            transcript,
          });
        }
      }

      const u = parseCodexUsage(event);
      if (u) {
        // Merge token fields; preserve the runner-maintained `turns`.
        usage.input = u.input;
        usage.output = u.output;
        usage.cacheRead = u.cacheRead;
        usage.cacheWrite = u.cacheWrite;
        usage.cost = u.cost;
        usage.contextTokens = u.contextTokens;
        hasRealUsage = true;
      }
      const errMsg = parseCodexError(event);
      if (errMsg) structuredError = errMsg;

      if (event.type === "turn.completed") sawTerminal = true;
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "codex CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const exitCode = code ?? 0;

      // Final message: prefer the --output-last-message file, fall back to the
      // last assistant text in the projected transcript.
      let finalMessage = "";
      try { finalMessage = readFileSync(outFile, "utf8").trim(); } catch {}
      if (!finalMessage) finalMessage = getFinalOutput(transcript);

      // Archive the teed JSONL stream. Failure (EACCES, ENOSPC) degrades to
      // transcriptPath=null rather than rejecting the close handler.
      let transcriptPath: string | null;
      try {
        const destDir = join(homedir(), ".pi", "agent", "sessions", "codex-cli");
        mkdirSync(destDir, { recursive: true });
        const dest = join(destDir, `${sessionId ?? id}.jsonl`);
        writeFileSync(dest, rawLines.join("\n"));
        transcriptPath = dest;
      } catch (e: any) {
        process.stderr.write(
          `[pi-interactive-subagent] codex transcript archive failed: ${e?.message ?? e}\n`,
        );
        transcriptPath = null;
      }

      // Warn if a clean stream ended without a thread.started session id; resume
      // will be unavailable. Never fabricate an id.
      if (exitCode === 0 && !sessionId) {
        process.stderr.write(
          `[pi-interactive-subagent] ${spec.name}: no thread.started session id seen — ` +
            `resume will be unavailable (Codex JSON format may have changed)\n`,
        );
      }

      if (wasAborted) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "aborted", sessionId, sessionKey: sessionId,
                  ...(hasRealUsage ? { usage } : {}), transcript });
        return;
      }
      if (exitCode !== 0) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode, elapsedMs,
                  error: structuredError || stderr.trim() || `codex exited with code ${exitCode}`,
                  sessionId, sessionKey: sessionId,
                  ...(hasRealUsage ? { usage } : {}), transcript });
        return;
      }
      if (!sawTerminal) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: structuredError || "child exited without completion event",
                  sessionId, sessionKey: sessionId,
                  ...(hasRealUsage ? { usage } : {}), transcript });
        return;
      }
      settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, sessionKey: sessionId,
                ...(hasRealUsage ? { usage } : {}), transcript });
    });
  });
}

async function archiveClaudeTranscript(sessionId: string): Promise<string | null> {
  const sourceFile = await findClaudeSessionFile(sessionId, 2000);
  if (!sourceFile) {
    process.stderr.write(
      `[pi-interactive-subagent] Claude session file ${sessionId}.jsonl not found ` +
        `under ~/.claude/projects/*/ after 2s; transcriptPath will be null.\n`,
    );
    return null;
  }
  const destDir = join(homedir(), ".pi", "agent", "sessions", "claude-code");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `${sessionId}.jsonl`);
  copyFileSync(sourceFile, dest);
  return dest;
}

export async function findClaudeSessionFile(
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
    }
    for (const slug of dirs) {
      const candidate = join(projectsRoot, slug, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function makeAbortedResult(
  spec: ResolvedLaunchSpec,
  startTime: number,
  transcript: TranscriptMessage[],
  usage: UsageStats,
): BackendResult {
  return {
    name: spec.name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - startTime,
    error: "aborted",
    // Include sessionKey for pi children so the caller can still route to the registry.
    // Unknown/typo cli values fall back to the pi path and own a session key too.
    ...(isPiLikeCli(spec.effectiveCli) ? { sessionKey: spec.subagentSessionFile } : {}),
    usage,
    transcript,
  };
}
