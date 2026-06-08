import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emitDiagnostic, createDiagnosticCollector, __test__,
  type Diagnostic,
} from "../../src/diagnostics/diagnostics.ts";

function withStderr(fn: (read: () => string) => void): void {
  let buf = "";
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: string | Buffer) => { buf += typeof c === "string" ? c : c.toString(); return true; };
  try { fn(() => buf); } finally { (process.stderr as any).write = orig; }
}

describe("emitDiagnostic", () => {
  it("human audience with no UI writes raw message (with newline) to stderr", () => {
    const prev = __test__.getAmbientUi();
    __test__.setAmbientUi(() => null);
    try {
      withStderr((read) => {
        emitDiagnostic({ code: "skills-dropped", audience: { human: true }, message: "warn line\n" });
        assert.equal(read(), "warn line\n");
      });
    } finally { __test__.setAmbientUi(prev); }
  });

  it("human audience with active UI notifies (trailing newline stripped) and skips stderr", () => {
    const prev = __test__.getAmbientUi();
    const calls: Array<{ m: string; t?: string }> = [];
    __test__.setAmbientUi(() => ({ hasUI: true, ui: { notify: (m, t) => calls.push({ m, t }) } }));
    try {
      withStderr((read) => {
        emitDiagnostic({ code: "skills-dropped", audience: { human: true }, message: "warn line\n" });
        assert.equal(read(), "");
        assert.deepEqual(calls, [{ m: "warn line", t: "warning" }]);
      });
    } finally { __test__.setAmbientUi(prev); }
  });

  it("structured audience pushes the exact message (byte-for-byte) to the collector; no collector is a silent no-op", () => {
    const prev = __test__.getAmbientUi();
    __test__.setAmbientUi(() => null);
    try {
      withStderr(() => {
        const collector = createDiagnosticCollector();
        const d: Diagnostic = { code: "tools-dropped", audience: { structured: true }, message: "structured line\n" };
        emitDiagnostic(d, { collector });
        assert.deepEqual(collector.drain(), ["structured line\n"]); // byte-for-byte: trailing newline preserved
        assert.deepEqual(collector.drain(), []); // drain clears
        assert.doesNotThrow(() => emitDiagnostic(d)); // no collector -> no throw
      });
    } finally { __test__.setAmbientUi(prev); }
  });

  it("{human,structured} with no UI delivers stderr AND collects; new sites need no local branching", () => {
    const prev = __test__.getAmbientUi();
    __test__.setAmbientUi(() => null);
    try {
      withStderr((read) => {
        const collector = createDiagnosticCollector();
        emitDiagnostic({ code: "guarded-policy-unsupported", audience: { human: true, structured: true }, message: "both line\n" }, { collector });
        assert.equal(read(), "both line\n");
        assert.deepEqual(collector.drain(), ["both line\n"]); // byte-for-byte: same string as the stderr human path
      });
    } finally { __test__.setAmbientUi(prev); }
  });
});
