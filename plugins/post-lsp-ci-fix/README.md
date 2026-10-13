# OMP Post-LSP CI Fix

An OMP extension that injects a hidden "fix the root cause" reminder whenever LSP diagnostics arrive — inline on edit/write results, late `lsp-late-diagnostic` messages, or explicit `lsp` tool calls.

## What it does

Two event handlers, no commands. Reminders are delivered as `tool_result.additionalContext` (trusted handler-authored context, not transcript spam) or appended to the outbound provider context — never as extra agent turns.

- `tool_result`
  - Explicit `lsp` diagnostics **with findings** → root-cause reminder. Clean `OK` results and navigation actions stay silent.
  - Inline diagnostics on `edit`/`write`/`apply_patch` results → reminder.
  - Failed verification commands (`vitest`, `tsc`, `eslint`, `pytest`, `cargo test`, …) → same philosophy, referring to the failing check. Ordinary failed shell commands are ignored.
  - LSP server/check failures → guidance to restore diagnostic coverage, not a code-defect lecture.
- `context` — one reminder per new actionable late-`lsp-late-diagnostic` batch, deduplicated across provider contexts (bounded 256-entry ledger, reset on session start/switch/shutdown). Stale batches from earlier turns are not re-litigated.

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
