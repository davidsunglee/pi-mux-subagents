// The integration harness must force-load this checkout's extension;
// auto-discovery could load an installed package snapshot instead.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { buildPiCommand, EXTENSION_SOURCE } from "./harness.ts";

describe("integration harness: working-tree extension loading", () => {
  it("EXTENSION_SOURCE points at the checkout's extension entry file", () => {
    assert.ok(
      isAbsolute(EXTENSION_SOURCE),
      `EXTENSION_SOURCE should be absolute, got ${EXTENSION_SOURCE}`,
    );
    assert.match(
      EXTENSION_SOURCE,
      /src[\\/]+index\.ts$/,
      `EXTENSION_SOURCE should end with src/index.ts, got ${EXTENSION_SOURCE}`,
    );
    assert.ok(
      existsSync(EXTENSION_SOURCE),
      `EXTENSION_SOURCE must exist on disk in the working tree: ${EXTENSION_SOURCE}`,
    );
  });

  it("buildPiCommand disables auto-discovery and force-loads the working-tree extension", () => {
    const cmd = buildPiCommand("/tmp/some-test-dir", "do a thing", {
      model: "anthropic/claude-haiku-4-5",
    });

    // -ne disables pi's extension auto-discovery so no installed package
    // snapshot is loaded.
    assert.match(
      cmd,
      /(^|\s)-ne(\s|$)/,
      `command must include -ne to disable extension auto-discovery: ${cmd}`,
    );

    // -e <path> force-loads the working-tree extension.
    assert.ok(
      cmd.includes(`-e `),
      `command must include -e <path> for the working-tree extension: ${cmd}`,
    );
    assert.ok(
      cmd.includes(EXTENSION_SOURCE),
      `command must reference the working-tree EXTENSION_SOURCE (${EXTENSION_SOURCE}): ${cmd}`,
    );

    // -ne must come before -e so auto-discovery is disabled before pi resolves
    // the explicit extension argument.
    const neIdx = cmd.indexOf("-ne");
    const eIdx = cmd.indexOf("-e ");
    assert.ok(
      neIdx !== -1 && eIdx !== -1 && neIdx < eIdx,
      `-ne should appear before -e in command: ${cmd}`,
    );
  });

  it("buildPiCommand approves project trust for unattended temp projects", () => {
    const cmd = buildPiCommand("/tmp/some-test-dir", "do a thing", {
      model: "anthropic/claude-haiku-4-5",
    });

    assert.match(
      cmd,
      /(^|\s)--approve(\s|$)/,
      `command must pass --approve so integration parents do not stall on Pi project trust: ${cmd}`,
    );
  });

  it("buildPiCommand still honors model and extraArgs (existing harness contract)", () => {
    const cmd = buildPiCommand("/tmp/some-test-dir", "task body", {
      model: "anthropic/claude-haiku-4-5",
      extraArgs: "--print",
    });

    assert.ok(cmd.startsWith("cd "), `command must cd into the test dir first: ${cmd}`);
    assert.ok(
      cmd.includes("--model"),
      `command must include --model for the configured test model: ${cmd}`,
    );
    assert.ok(
      cmd.includes("anthropic/claude-haiku-4-5"),
      `command must include the chosen model name: ${cmd}`,
    );
    assert.ok(cmd.includes("--print"), `command must pass extraArgs through verbatim: ${cmd}`);
  });
});
