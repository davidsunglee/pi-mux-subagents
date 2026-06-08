/**
 * Identity-delivery seam.
 *
 * Every backend (pi, Claude, Codex) declares HOW the composed agent identity
 * (agent body + per-call systemPrompt) reaches the model: through a dedicated
 * system-prompt channel (a CLI flag, out-of-band from the task body) or inside
 * the task body itself. This seam is total over PaneBackend and the totality is
 * enforced at COMPILE TIME (see IDENTITY_DELIVERY's mapped type and the policy
 * guard below): adding a backend without an explicit identity-delivery row is a
 * `tsc` error, so no backend can silently inherit another's identity-delivery
 * assumption.
 *
 * This is the identity counterpart to the completion-protocol seam
 * (pane-completion-protocol.ts). The triggering bug: Codex has no system-prompt
 * flag, yet inherited the system-prompt-channel assumption that only holds for
 * backends that actually have one (Claude, pi) — so identity was silently
 * dropped from the Codex task whenever an agent declared `system-prompt:
 * append|replace`. Modeling identity delivery as a first-class, per-backend
 * capability makes Codex's "no channel" row deliver identity in the task body by
 * construction, on both the pane and headless paths, while ENCODING (not
 * changing) Claude's always-system-prompt routing and pi's hybrid routing.
 */

import type { PaneBackend } from "./pane-completion-protocol.ts";
import { assertNever } from "./pane-completion-protocol.ts";

export type SystemPromptMode = "append" | "replace";

/**
 * How identity reaches a backend:
 * - "system-prompt-always": the backend owns a dedicated system-prompt flag and
 *   identity ALWAYS travels through it, never the task body (Claude). The
 *   system-prompt mode only switches the flag (append vs replace).
 * - "system-prompt-when-mode": the backend owns a system-prompt flag; identity
 *   travels through it only when the agent declares `system-prompt:
 *   append|replace`, otherwise it rides the task body as a role block (pi).
 * - "task-body-only": the backend has NO system-prompt channel, so identity
 *   ALWAYS rides the task body regardless of the declared mode (Codex).
 */
export type IdentityChannelPolicy =
  | "system-prompt-always"
  | "system-prompt-when-mode"
  | "task-body-only";

export interface IdentityDelivery {
  backend: PaneBackend;
  /**
   * Whether this backend owns a system-prompt channel for identity. Codex does
   * not; Claude and pi do. Consumers MUST read this declaration rather than
   * special-casing backend names.
   */
  hasSystemPromptChannel: boolean;
  /** How identity reaches this backend. See IdentityChannelPolicy. */
  policy: IdentityChannelPolicy;
}

/**
 * Total over PaneBackend. The mapped type makes a missing backend a `tsc` error
 * (requirement: no silent inheritance — a new pane/headless backend cannot be
 * added without declaring its identity-delivery capability).
 */
export const IDENTITY_DELIVERY: { readonly [B in PaneBackend]: IdentityDelivery } = {
  pi: { backend: "pi", hasSystemPromptChannel: true, policy: "system-prompt-when-mode" },
  claude: { backend: "claude", hasSystemPromptChannel: true, policy: "system-prompt-always" },
  codex: { backend: "codex", hasSystemPromptChannel: false, policy: "task-body-only" },
};

export function resolveIdentityDelivery(backend: PaneBackend): IdentityDelivery {
  // Direct typed lookup — NO default branch, so an unknown backend cannot
  // silently inherit another backend's identity-delivery semantics.
  return IDENTITY_DELIVERY[backend];
}

/**
 * Whether the composed identity should travel through the backend's
 * system-prompt channel (true) instead of the task body (false), given the
 * declared system-prompt mode. Both the task-body composition (role block) and
 * the system-prompt-flag/artifact emission derive from this single decision.
 *
 * The switch is total over IdentityChannelPolicy; an unhandled policy is a `tsc`
 * error via `assertNever`, so a new policy fails visibly instead of silently
 * borrowing another's routing.
 */
export function identityRoutesToSystemPrompt(
  delivery: IdentityDelivery,
  systemPromptMode: SystemPromptMode | undefined,
): boolean {
  switch (delivery.policy) {
    case "system-prompt-always":
      return true;
    case "system-prompt-when-mode":
      return systemPromptMode != null;
    case "task-body-only":
      return false;
    default:
      return assertNever(delivery.policy);
  }
}
