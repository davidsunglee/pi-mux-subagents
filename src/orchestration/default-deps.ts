import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeHeadlessBackend } from "../backends/headless.ts";
import { makePaneBackend } from "../backends/pane.ts";
import { selectBackend } from "../backends/select.ts";
import type { Backend, BackendLaunchParams } from "../backends/types.ts";
import {
  registerHeadlessSubagent,
  updateHeadlessSubagentUsage,
  unregisterHeadlessSubagent,
  resolveEffectiveInteractive,
  loadAgentDefaults,
} from "../index.ts";
import type {
  LauncherDeps,
  LaunchedHandle,
  OrchestrationResult,
  OrchestrationTask,
  WaitForCompletionHooks,
} from "./types.ts";

/**
 * Build a LauncherDeps bound to the active session context.
 *
 * Select a backend (pane or headless) once per makeDefaultDeps() call via
 * selectBackend(), then adapt that backend's launch/watch surface to the
 * orchestration layer's existing LauncherDeps contract.
 *
 * The pane backend preserves the current launchSubagent/watchSubagent path,
 * including transcriptPath population and abort forwarding. The headless
 * backend owns its own launch/watch behavior behind the same interface.
 *
 * OrchestrationTask -> BackendLaunchParams is a structural widening only:
 * the orchestration tools require `agent`, while the backend interface keeps
 * it optional to match the broader bare-subagent surface.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const isHeadless = selectBackend() === "headless";
  const backend: Backend = isHeadless ? makeHeadlessBackend(ctx) : makePaneBackend(ctx);

  return {
    async launch(
      task: OrchestrationTask,
      defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const params: BackendLaunchParams = task;
      const handle = await backend.launch(params, defaultFocus, signal);
      if (isHeadless) {
        const agentDefs = task.agent ? loadAgentDefaults(task.agent) : null;
        const interactive = resolveEffectiveInteractive({ ...task, name: handle.name }, agentDefs);
        // Mirror backend.launch()'s CLI resolution: explicit task param wins,
        // then agent frontmatter `cli`, else pi (unknown values fall back to pi).
        const effectiveCli = task.cli ?? agentDefs?.cli ?? "pi";
        const source = effectiveCli === "claude" || effectiveCli === "codex" ? "claude" : "pi";
        registerHeadlessSubagent({
          id: handle.id,
          name: handle.name,
          task: task.task,
          agent: task.agent,
          cli: effectiveCli,
          startTime: handle.startTime,
          activityFile: handle.activityFile,
          interactive,
          source,
        });
      }
      return handle;
    },

    async waitForCompletion(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: OrchestrationResult) => void,
      hooks?: WaitForCompletionHooks,
    ): Promise<OrchestrationResult> {
      try {
        const result = await backend.watch(
          handle,
          signal,
          (partial) => {
            if (isHeadless && partial.usage) {
              updateHeadlessSubagentUsage(handle.id, partial.usage);
            }
            if (onUpdate) {
              onUpdate({
                name: partial.name,
                finalMessage: partial.finalMessage,
                transcriptPath: partial.transcriptPath,
                exitCode: partial.exitCode,
                elapsedMs: partial.elapsedMs,
                sessionId: partial.sessionId,
                error: partial.error,
                usage: partial.usage,
                transcript: partial.transcript,
                sessionKey: partial.sessionKey,
                ping: partial.ping,
              });
            }
          },
          hooks,
        );
        return {
          name: result.name,
          finalMessage: result.finalMessage,
          transcriptPath: result.transcriptPath,
          exitCode: result.exitCode,
          elapsedMs: result.elapsedMs,
          sessionId: result.sessionId,
          error: result.error,
          usage: result.usage,
          transcript: result.transcript,
          sessionKey: result.sessionKey,
          ping: result.ping,
        };
      } finally {
        if (isHeadless) {
          unregisterHeadlessSubagent(handle.id);
        }
      }
    },
  };
}
