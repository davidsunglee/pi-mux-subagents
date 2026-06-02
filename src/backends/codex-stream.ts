import type { TranscriptContent, TranscriptMessage, UsageStats } from "./types.ts";
import type { ResolvedLaunchSpec } from "../launch/launch-spec.ts";
import { shellEscape } from "../mux/shell.ts";

const CODEX_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export function codexReasoningEffort(thinking: string | undefined): string | undefined {
  if (!thinking) return undefined;
  const v = thinking.toLowerCase().trim();
  return CODEX_REASONING_EFFORTS.has(v) ? v : undefined; // "off"/unknown → omitted
}

export function codexSandboxArgs(policy: "guarded" | "unrestricted", transport: "headless" | "pane"): string[] {
  if (policy === "unrestricted") return ["--dangerously-bypass-approvals-and-sandbox"];
  // guarded:
  return transport === "headless"
    ? ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']   // non-interactive: cannot answer prompts
    : ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]; // interactive: a human can answer
}

export function buildCodexExecArgs(
  spec: ResolvedLaunchSpec,
  opts: { outputLastMessageFile: string; cwd: string },
): string[] {
  const args: string[] = ["exec"];
  if (spec.resumeSessionId) args.push("resume", spec.resumeSessionId);
  args.push(
    "--json", "--output-last-message", opts.outputLastMessageFile,
    "--cd", opts.cwd, "--skip-git-repo-check",
  );
  if (spec.codexModelArg) args.push("--model", spec.codexModelArg);
  const effort = codexReasoningEffort(spec.effectiveThinking);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push(...codexSandboxArgs(spec.effectiveExecutionPolicy, "headless"));
  return args;
}

export function buildCodexPaneCmdParts(input: {
  model?: string;
  effectiveThinking?: string;
  executionPolicy: "guarded" | "unrestricted";
  mcpOverrideArgs: string[];
  task: string;
}): string[] {
  const parts: string[] = ["codex"];
  parts.push(...codexSandboxArgs(input.executionPolicy, "pane").map(shellEscape));
  if (input.model) parts.push("--model", shellEscape(input.model));
  const effort = codexReasoningEffort(input.effectiveThinking);
  if (effort) parts.push("-c", shellEscape(`model_reasoning_effort="${effort}"`));
  parts.push(...input.mcpOverrideArgs.map(shellEscape)); // already raw `-c key=value` tokens
  if (input.task !== "") { parts.push("--"); parts.push(shellEscape(input.task)); }
  return parts;
}

export function parseCodexEvent(event: Record<string, unknown>): TranscriptMessage[] | undefined {
  if (event.type !== "item.completed") return undefined;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item) return undefined;
  if (item.type === "agent_message" && typeof item.text === "string")
    return [{ role: "assistant", content: [{ type: "text", text: item.text }] }];
  if (item.type === "reasoning" && typeof item.text === "string")
    return [{ role: "assistant", content: [{ type: "thinking", thinking: item.text }] }];
  if (item.type === "command_execution" || item.type === "tool_call" || item.type === "mcp_tool_call")
    return [{ role: "assistant", content: [{ type: "toolCall",
      id: String(item.id ?? ""), name: String((item.name ?? item.command ?? item.type) as string).toLowerCase(),
      arguments: (item as any).arguments ?? (item as any).command ?? {} }] }];
  return undefined; // unknown item types are skipped, not fabricated
}

export function extractCodexSessionId(event: Record<string, unknown>): string | undefined {
  // Defensive: the id field name is version-sensitive. Check the known carriers.
  if (event.type === "thread.started") {
    const e: any = event;
    const id = e.thread_id ?? e.threadId ?? e.session_id ?? e.sessionId ?? e.thread?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

export interface CodexUsageDelta { usage: UsageStats; }

export function parseCodexUsage(event: Record<string, unknown>): UsageStats | undefined {
  if (event.type !== "turn.completed") return undefined;
  const u = ((event as any).usage ?? {}) as Record<string, number>;
  const input = u.input_tokens ?? u.input ?? 0;
  const output = u.output_tokens ?? u.output ?? 0;
  const cacheRead = u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0;
  return { input, output, cacheRead, cacheWrite: 0, cost: 0,
           contextTokens: input + output + cacheRead, turns: 0 };
}
