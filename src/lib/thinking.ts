/**
 * Audience-facing thinking is a short explanation, not a transcript.
 *
 * The full text still streams and still lands in `seat.submitted` (AGENTS §5:
 * never drop the tail — a stalled feed reads as a hang). This module only decides
 * how much of it is shown before the audience has to ask for the rest.
 */

export const THINKING_LIMIT = 500;

export interface ThinkingParts {
  /** Shown by default. */
  head: string;
  /** Hidden behind「展开全文」; empty when the text is short enough. */
  rest: string;
  over: boolean;
}

export function splitThinking(text: string, limit: number = THINKING_LIMIT): ThinkingParts {
  const source = typeof text === "string" ? text : "";
  if (!Number.isFinite(limit) || limit <= 0) {
    return { head: "", rest: source, over: source.length > 0 };
  }
  if (source.length <= limit) return { head: source, rest: "", over: false };
  return { head: source.slice(0, limit), rest: source.slice(limit), over: true };
}
