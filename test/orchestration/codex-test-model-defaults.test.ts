import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { getTestModel } from "../integration/harness.ts";

describe("codex-test-model-defaults", () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.PI_TEST_MODEL;
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.PI_TEST_MODEL;
    else process.env.PI_TEST_MODEL = savedEnv;
  });

  it("with PI_TEST_MODEL unset: returns per-CLI defaults", () => {
    delete process.env.PI_TEST_MODEL;
    assert.strictEqual(getTestModel("pi"), "anthropic/claude-haiku-4-5");
    assert.strictEqual(getTestModel("claude"), "claude-haiku-4-5");
    assert.strictEqual(getTestModel("codex"), "gpt-5.4-mini");
  });

  it("with PI_TEST_MODEL set: overrides all CLIs globally", () => {
    process.env.PI_TEST_MODEL = "x/y";
    assert.strictEqual(getTestModel("pi"), "x/y");
    assert.strictEqual(getTestModel("claude"), "x/y");
    assert.strictEqual(getTestModel("codex"), "x/y");
  });
});
