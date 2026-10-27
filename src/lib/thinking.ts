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

/**
 * How much of a live stream stays in the DOM.
 *
 * Re-rendering an ever-growing paragraph costs the browser a full text layout on
 * every tick, so a 30 000-character stream crawls exactly when it gets interesting.
 * Keeping the live surface to a bounded tail makes each tick cost the same at 1 000
 * and at 100 000 characters; the full text is never lost — it is in `seat.submitted`
 * and in the round record.
 */
export const LIVE_TAIL_CHARS = 4_000;

/** Index of the first chunk inside the tail window. Walks backwards, O(dropped). */
export function tailWindowStart(
  chunks: readonly string[],
  limit: number = LIVE_TAIL_CHARS,
): number {
  if (!Number.isFinite(limit) || limit <= 0) return chunks.length;
  let total = 0;
  let start = chunks.length;
  while (start > 0) {
    const len = chunks[start - 1]?.length ?? 0;
    // Always keep the last chunk, however long it is: a truncating tail would look
    // like a dropped character.
    if (total + len > limit && start < chunks.length) break;
    total += len;
    start -= 1;
  }
  return start;
}

/**
 * Split prose into blocks so long text can be laid out lazily.
 * Blank lines survive as empty blocks, which keeps `pre-wrap` spacing intact.
 */
export function splitBlocks(text: string): string[] {
  if (!text) return [];
  return text.split("\n");
}
