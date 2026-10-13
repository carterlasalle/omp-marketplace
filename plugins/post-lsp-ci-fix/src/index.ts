import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const INJECTION_TYPE = "post-lsp-ci-fix";
const LATE_LSP_TYPE = "lsp-late-diagnostic";

const POST_LSP_PROMPT =
  "Errors and warnings are clues, not nuisances—signs of unwired, unfinished, broken, or sloppy code. " +
  "Trace each one to its source and fix the root cause. Never suppress, ignore, baseline, or delete your way to green. " +
  "Continue only after addressing the LSP feedback.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * OMP can return automatic LSP diagnostics directly on edit/write results.
 *
 * Single-file shape:
 *   details.diagnostics
 *
 * Multi-file edit shape:
 *   details.perFileResults[*].diagnostics
 */
function hasInlineLspFeedback(details: unknown): boolean {
  if (!isRecord(details)) return false;

  if (Object.hasOwn(details, "diagnostics") && details.diagnostics !== undefined) {
    return true;
  }

  const perFileResults = details.perFileResults;
  if (!Array.isArray(perFileResults)) return false;

  return perFileResults.some(
    (result) =>
      isRecord(result) &&
      Object.hasOwn(result, "diagnostics") &&
      result.diagnostics !== undefined,
  );
}

function makeHiddenInjection(source: string) {
  return {
    role: "custom" as const,
    customType: INJECTION_TYPE,
    content: POST_LSP_PROMPT,
    display: false,
    attribution: "agent" as const,
    details: { source },
    timestamp: Date.now(),
  };
}

export default function postLspCiFix(pi: ExtensionAPI): void {
  /**
   * Late diagnostics are already injected by OMP at a step boundary.
   *
   * If we responded to message_end with another "aside", that new aside could
   * miss the boundary currently being assembled and land one model step later.
   * Instead, remember that the late diagnostic arrived and append our reminder
   * in the immediately following `context` transform.
   */
  let pendingLateLspFeedback = 0;

  /**
   * Explicit LSP tool results + fast automatic diagnostics.
   *
   * `aside` is non-interrupting: it waits for the next agent-step boundary
   * instead of steering/aborting the current tool batch.
   */
  pi.on("tool_result", (event) => {
    if (event.toolName === "lsp") {
      pi.sendMessage(
        {
          customType: INJECTION_TYPE,
          content: POST_LSP_PROMPT,
          display: false,
          attribution: "agent",
          details: { source: "explicit-lsp" },
        },
        { deliverAs: "aside" },
      );
      return;
    }

    if (
      (event.toolName === "edit" ||
        event.toolName === "write" ||
        event.toolName === "apply_patch") &&
      hasInlineLspFeedback((event as { details?: unknown }).details)
    ) {
      pi.sendMessage(
        {
          customType: INJECTION_TYPE,
          content: POST_LSP_PROMPT,
          display: false,
          attribution: "agent",
          details: { source: `inline-${event.toolName}-diagnostics` },
        },
        { deliverAs: "aside" },
      );
    }
  });

  /**
   * Slow automatic diagnostics.
   *
   * OMP emits these as a hidden custom message whose customType is exactly
   * "lsp-late-diagnostic".
   */
  pi.on("message_end", (event) => {
    const message = event.message;
    if (
      isRecord(message) &&
      message.role === "custom" &&
      message.customType === LATE_LSP_TYPE
    ) {
      pendingLateLspFeedback += 1;
    }
  });

  /**
   * Put the reminder into the same next provider context as any newly-arrived
   * late LSP diagnostic(s). One reminder is appended per late diagnostic
   * message received since the previous context build.
   */
  pi.on("context", (event) => {
    if (pendingLateLspFeedback === 0) return;

    const count = pendingLateLspFeedback;
    pendingLateLspFeedback = 0;

    const messages = [...event.messages];
    for (let i = 0; i < count; i += 1) {
      messages.push(makeHiddenInjection("late-lsp-diagnostics"));
    }

    return { messages };
  });
}
