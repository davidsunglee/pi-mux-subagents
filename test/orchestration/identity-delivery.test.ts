import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_DELIVERY,
  resolveIdentityDelivery,
  identityRoutesToSystemPrompt,
} from "../../src/launch/identity-delivery.ts";
import { ALL_PANE_BACKENDS } from "../../src/launch/pane-completion-protocol.ts";

describe("identity-delivery seam", () => {
  it("declares a delivery row for every pane backend (totality)", () => {
    for (const backend of ALL_PANE_BACKENDS) {
      const row = resolveIdentityDelivery(backend);
      assert.equal(row.backend, backend, `row for ${backend} must name itself`);
    }
  });

  it("Codex has no system-prompt channel; Claude and pi do", () => {
    assert.equal(IDENTITY_DELIVERY.codex.hasSystemPromptChannel, false);
    assert.equal(IDENTITY_DELIVERY.claude.hasSystemPromptChannel, true);
    assert.equal(IDENTITY_DELIVERY.pi.hasSystemPromptChannel, true);
  });

  it("Codex always routes identity to the task body, regardless of system-prompt mode", () => {
    const codex = resolveIdentityDelivery("codex");
    assert.equal(identityRoutesToSystemPrompt(codex, undefined), false);
    assert.equal(identityRoutesToSystemPrompt(codex, "append"), false);
    assert.equal(identityRoutesToSystemPrompt(codex, "replace"), false);
  });

  it("pi routes identity to the system-prompt channel only when a mode is declared (hybrid)", () => {
    const pi = resolveIdentityDelivery("pi");
    assert.equal(identityRoutesToSystemPrompt(pi, undefined), false);
    assert.equal(identityRoutesToSystemPrompt(pi, "append"), true);
    assert.equal(identityRoutesToSystemPrompt(pi, "replace"), true);
  });

  it("Claude always routes identity to the system-prompt channel (mode only switches the flag)", () => {
    const claude = resolveIdentityDelivery("claude");
    assert.equal(identityRoutesToSystemPrompt(claude, undefined), true);
    assert.equal(identityRoutesToSystemPrompt(claude, "append"), true);
    assert.equal(identityRoutesToSystemPrompt(claude, "replace"), true);
  });
});
