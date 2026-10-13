# OMP Post-LSP CI Fix

An OMP extension that injects a hidden "fix the root cause" reminder whenever LSP diagnostics arrive — inline on edit/write results, late `lsp-late-diagnostic` messages, or explicit `lsp` tool calls.

## What it does

Three event handlers, no commands:

- `tool_result` — explicit `lsp` tool results and inline diagnostics on `edit`/`write`/`apply_patch` results trigger an immediate hidden reminder (`deliverAs: "aside"`, non-interrupting).
- `message_end` — counts arriving `lsp-late-diagnostic` custom messages.
- `context` — appends one hidden reminder per late diagnostic into the next provider context, so slow diagnostics steer the very next model step instead of landing a step late.

The reminder text:

> Errors and warnings are clues, not nuisances — signs of unwired, unfinished, broken, or sloppy code. Trace each one to its source and fix the root cause. Never suppress, ignore, baseline, or delete your way to green. Continue only after addressing the LSP feedback.

## Install

Via the marketplace:

```
/marketplace add carterlasalle/omp-marketplace
/marketplace install post-lsp-ci-fix@carter-omp-marketplace
```

Or link for local development:

```bash
omp plugin link ./plugins/post-lsp-ci-fix
```

Restart OMP after install — extension modules load at startup.

## License

MIT
