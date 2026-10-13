/**
 * Post-LSP/CI root-cause reminders for stock OMP (no fork required).
 *
 * Keeps the original ci-fix-dont-freeze-inspired language intact.
 * Requires no custom OMP patches. Uses tool_result.additionalContext for
 * immediate results and context for OMP's batched late LSP diagnostics.
 *
 * All LSP settings are configured separately; this extension does not
 * change lsp.diagnosticsOnEdit, lsp.diagnosticsOnWrite, or deduplication.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const INJECTION_TYPE = "post-lsp-ci-fix";
const LATE_LSP_TYPE = "lsp-late-diagnostic";

const ENABLE_LATE_CONTEXT_REMINDER = true;
const ENABLE_FAILED_VERIFICATION_REMINDER = true;

/** User's original language, preserved verbatim. */
const POST_LSP_PROMPT =
  "Errors and warnings are clues, not nuisances—signs of unwired, unfinished, broken, or sloppy code. " +
  "Trace each one to its source and fix the root cause. Never suppress, ignore, baseline, or delete your way to green. " +
  "Continue only after addressing the LSP feedback.";

/** For verification commands, keep the same premise, but refer to the check. */
const POST_CI_PROMPT =
  "Errors and warnings are clues, not nuisances—signs of unwired, unfinished, broken, or sloppy code. " +
  "Trace each one to its source and fix the root cause. Never suppress, ignore, baseline, or delete your way to green. " +
  "Continue only after addressing the failing check and rerunning it.";

const CHECK_FAILURE_GUIDANCE =
  "The LSP check could not reliably verify the code. Fix the check/server or target selection; do not treat missing diagnostics as a clean result.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionableLine(value: unknown): boolean {
  // Warnings, errors, and other nonempty diagnostics are clues, including hints.
  return typeof value === "string" && value.trim().length > 0;
}

/** OMP FileDiagnosticsResult: { messages: string[], summary, errored, server? }. */
function hasActionableDiagnostics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const messages = value.messages;
  if (Array.isArray(messages)) {
    return messages.some(isActionableLine) || value.errored === true;
  }
  // Errored metadata without messages is still worth investigating.
  return value.errored === true;
}

/** One edit may contain details.diagnostics or details.perFileResults[*].diagnostics. */
function hasInlineDiagnostics(details: unknown): boolean {
  if (!isRecord(details)) return false;
  if (hasActionableDiagnostics(details.diagnostics)) return true;
  return (
    Array.isArray(details.perFileResults) &&
    details.perFileResults.some(
      (result: unknown) => isRecord(result) && hasActionableDiagnostics(result.diagnostics),
    )
  );
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    // ANSI escape sequences from terminal/diagnostics rendering should not influence parsing.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

function explicitLspGuidance(event: {
  input: Record<string, unknown>;
  content: unknown;
  details?: unknown;
  isError: boolean;
}): string | undefined {
  if (event.input.action !== "diagnostics") return undefined;
  const text = toolText(event.content);
  const details = event.details;
  if (event.isError || (isRecord(details) && details.success === false)) {
    return CHECK_FAILURE_GUIDANCE;
  }

  // A partial LSP-server failure should not mask genuine findings from
  // servers that did respond. Diagnose the findings and restore coverage.
  const hasFindings =
    /\[(?:error|warning|info|hint)\]/i.test(text) ||
    /\b[1-9]\d*\s+(?:error\(s\)|warning\(s\)|info\(s\)|hint\(s\)|errors?|warnings?|problems?)\b/i.test(text);
  if (hasFindings) {
    return /\bsome servers failed\b/i.test(text)
      ? `${POST_LSP_PROMPT} Also restore the failed LSP servers so verification is complete.`
      : POST_LSP_PROMPT;
  }

  if (
    /\b(?:all language servers failed|some servers failed|no language server found|no files matched pattern|file parameter required)\b/i.test(text)
  ) {
    return CHECK_FAILURE_GUIDANCE;
  }

  if (!text) return CHECK_FAILURE_GUIDANCE;
  if (/^OK\s*$/i.test(text)) return undefined;
  // A clean row in a mixed workspace report must never make the whole report
  // look clean. All nonempty lines must be known clean/status-only forms.
  const cleanRows = text.split("\n").map(line => line.trim()).filter(Boolean);
  if (cleanRows.every(line =>
    /^OK$/i.test(line) ||
    /^(?:no issues|no diagnostics|no problems)$/i.test(line) ||
    /^(?:[^:]+:\s*)?(?:no issues|no diagnostics|no problems)$/i.test(line) ||
    /^0 errors?(?:,?\s+0 warnings?)?$/i.test(line) ||
    /^0 warnings?(?:,?\s+0 errors?)?$/i.test(line) ||
    /^workspace diagnostics \([^)]*\):$/i.test(line),
  )) {
    return undefined;
  }

  // Workspace diagnostics can have different reporting formats.
  // Treat non-clean output as something to investigate, not proof of a bug.
  return POST_LSP_PROMPT;
}

// Intentionally narrow: don't turn an ordinary failed shell command into a CI loop.
const VERIFY_COMMAND_RE =
  /(?:^|\n|;|&&|\|\|)\s*(?:(?:yarn|npm|pnpm|bun)(?:\s+run)?\s+(?:test|lint|typecheck|type-check|check|build|verify|ci)(?:\b|:)|uv\s+run\s+(?:(?:python\s+-m\s+)?(?:pytest|ruff|mypy|pyright)|ty\s+check)\b|(?:cargo\s+(?:test|check|clippy|build)|go\s+test|(?:npx\s+)?(?:tsc|eslint|vitest|jest|biome|oxlint)\b))/i;

function isFailedVerification(event: {
  input: Record<string, unknown>;
  details?: unknown;
  isError: boolean;
}): boolean {
  const command = event.input.command;
  if (typeof command !== "string" || !VERIFY_COMMAND_RE.test(command)) return false;
  const details = event.details;
  if (isRecord(details) && details.timedOut === true) return false;
  // Async jobs may not have finished yet: avoid incorrectly treating their
  // initial job submission as a CI failure.
  if (isRecord(details) && isRecord(details.async) && details.async.state === "running") {
    return false;
  }
  return event.isError || (isRecord(details) && typeof details.exitCode === "number" && details.exitCode !== 0);
}

type LateMessage = {
  role: "custom";
  customType: string;
  content: unknown;
  timestamp?: unknown;
  details?: unknown;
};

function isLateLspMessage(value: unknown): value is LateMessage {
  return isRecord(value) && value.role === "custom" && value.customType === LATE_LSP_TYPE;
}

function lateMessageKey(message: LateMessage): string {
  return `${typeof message.timestamp === "number" ? message.timestamp : "missing"}\0${
    typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  }`;
}

function lateMessageIsActionable(message: LateMessage): boolean {
  const details = message.details;
  if (isRecord(details) && Array.isArray(details.files)) {
    return details.files.some((file: unknown) =>
      isRecord(file) &&
      (hasActionableDiagnostics(file) ||
        (Array.isArray(file.messages) && file.messages.some(isActionableLine))),
    );
  }
  // Forward compatibility for a changed OMP late-diagnostic payload. Avoid
  // injecting on a plain, clean "no issues" notice.
  return typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    !/\b(?:no issues|no diagnostics)\b/i.test(message.content);
}

function lateReminder(count: number) {
  return {
    role: "custom" as const,
    customType: INJECTION_TYPE,
    display: false,
    attribution: "agent" as const,
    content: `${count} new late-LSP diagnostic ${count === 1 ? "batch was" : "batches were"} delivered just before this model step. ${POST_LSP_PROMPT}`,
    details: { source: "late-lsp-diagnostics", batches: count },
    timestamp: Date.now(),
  };
}

export default function postLspCiFix(pi: ExtensionAPI): void {
  pi.setLabel("Post LSP / CI Fix");

  pi.on("tool_result", event => {
    if (event.toolName === "lsp") {
      const reminder = explicitLspGuidance(event);
      return reminder ? { additionalContext: reminder } : undefined;
    }

    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "apply_patch") {
      if (hasInlineDiagnostics(event.details)) {
        return { additionalContext: POST_LSP_PROMPT };
      }
      return;
    }

    if (ENABLE_FAILED_VERIFICATION_REMINDER && event.toolName === "bash" && isFailedVerification(event)) {
      return { additionalContext: POST_CI_PROMPT };
    }
  });

  if (!ENABLE_LATE_CONTEXT_REMINDER) return;

  // Context-only reminder for OMP's already-batched late LSP notices.
  // Keep a bounded identity ledger so repeated provider contexts don't repeat
  // the reminder for the same notice. Session switches reset this ledger.
  const seenLate = new Set<string>();
  pi.on("session_start", () => seenLate.clear());
  pi.on("session_switch", () => seenLate.clear());
  pi.on("session_shutdown", () => seenLate.clear());

  pi.on("context", event => {
    // Older late diagnostics from an already-completed turn should not be
    // re-litigated after the user starts a later turn or resumes a session.
    let latestUserIndex = -1;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i]?.role === "user") {
        latestUserIndex = i;
        break;
      }
    }

    let newActionableBatches = 0;
    for (let i = 0; i < event.messages.length; i++) {
      const message = event.messages[i];
      if (!isLateLspMessage(message)) continue;
      const key = lateMessageKey(message);
      if (seenLate.has(key)) continue;
      seenLate.add(key);
      if (seenLate.size > 256) {
        const oldest = seenLate.values().next().value;
        if (oldest !== undefined) seenLate.delete(oldest);
      }
      if (i > latestUserIndex && lateMessageIsActionable(message)) {
        newActionableBatches++;
      }
    }

    if (newActionableBatches === 0) return;
    // Only the outbound context is changed: do not persist the second reminder
    // into the transcript, and never create a second agent turn.
    return { messages: [...event.messages, lateReminder(newActionableBatches)] };
  });
}
