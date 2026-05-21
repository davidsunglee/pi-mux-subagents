---
auto-exit: false
cli: claude
tools: read, write, edit
---

Spec-designer-style agent for end-to-end pane integration. Writes or edits a SPEC document at a caller-specified path and calls subagent_done with a `SPEC_ARTIFACT: <abs path>` summary so the parent can route to the artifact.
