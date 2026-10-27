/**
 * Incremental parser for the participant output protocol.
 *
 *   <<<THINK>>>            (optional live draft; werewolf only)
 *   free-form reasoning, streamed live to the audience only
 *   <<<SUBMIT>>>
 *   {"note": "写给观众的旁白", "bid": 300, "statement": "..."}
 *
 * The thinking half is forwarded as it arrives; the submission half is buffered and
 * only handed over once complete. A `note` field inside the payload is authoritative
 * when the caller opts in (werewolf), so a model cannot satisfy the schema by
 * skipping the free-form marker. Every degradation path is explicit so the runtime
 * can record an `anomaly` instead of silently swallowing a bad turn.
 */

const THINK_MARKERS = ["<<<THINK>>>", "<<<THINK>>", "<<THINK>>", "===THINK==="];
const SUBMIT_MARKERS = ["<<<SUBMIT>>>", "<<<SUBMIT>>", "<<SUBMIT>>", "<<<ACT>>>", "===SUBMIT==="];
const SUBMIT_KEEP = Math.max(...SUBMIT_MARKERS.map((m) => m.length)) - 1;

function findMarker(buf: string, markers: string[]): { index: number; len: number } | null {
  let best: { index: number; len: number } | null = null;
  for (const m of markers) {
    const i = buf.indexOf(m);
    if (i !== -1 && (best === null || i < best.index)) best = { index: i, len: m.length };
  }
  return best;
}

/** Escape raw control characters that would otherwise make JSON.parse throw. */
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

export function repairJson(input: string): string {
  let text = input.trim();
  text = text.replace(/^```(?:json|JSON)?\s*/g, "").replace(/```\s*$/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);
  text = escapeControlCharsInStrings(text);
  text = text.replace(/,\s*([}\]])/g, "$1");
  return text;
}

export function parseSubmitPayload(raw: string): {
  content: Record<string, unknown> | null;
  error: string | null;
} {
  const cleaned = repairJson(raw);
  if (!cleaned) return { content: null, error: "empty_submit_payload" };
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch (err) {
    return { content: null, error: `json_parse_failed: ${(err as Error).message}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { content: null, error: "submit_not_object" };
  }
  return { content: obj as Record<string, unknown>, error: null };
}

export class SubmissionStreamParser {
  private buf = "";
  private mode: "seek_think" | "thinking" | "submit" = "seek_think";
  private thinkingText = "";
  private submitText = "";
  private rawText = "";
  /** How much of the `note` field has already been streamed to the audience. */
  private noteStreamed = 0;

  /**
   * `noteField` opts into the structured protocol: a `note` string inside the
   * submit JSON is the audience note, even when the model skipped `<<<THINK>>>`.
   * The rubric runtime leaves it off so a blueprint slot named `note` is untouched.
   */
  constructor(private readonly options: { noteField?: boolean } = {}) {}

  /** Feed a delta; returns the newly available thinking text ("" if none). */
  push(chunk: string): string {
    if (!chunk) return "";
    this.rawText += chunk;
    this.buf += chunk;
    let out = "";

    for (;;) {
      if (this.mode === "seek_think") {
        const thinkHit = findMarker(this.buf, THINK_MARKERS);
        const submitHit = findMarker(this.buf, SUBMIT_MARKERS);
        // A model that skipped the thinking marker and went straight to the payload.
        if (submitHit && (!thinkHit || submitHit.index < thinkHit.index)) {
          const before = this.buf.slice(0, submitHit.index);
          this.thinkingText += before;
          out += before;
          this.buf = this.buf.slice(submitHit.index + submitHit.len);
          this.mode = "submit";
          continue;
        }
        if (!thinkHit) {
          if (looksLikeJsonStart(this.buf)) {
            this.mode = "submit";
            continue;
          }
          if (this.buf.length <= 48) return out;
          this.mode = "thinking";
          continue;
        }
        this.buf = this.buf.slice(thinkHit.index + thinkHit.len);
        this.mode = "thinking";
        continue;
      }

      if (this.mode === "thinking") {
        const hit = findMarker(this.buf, SUBMIT_MARKERS);
        if (!hit) {
          if (this.buf.length > SUBMIT_KEEP) {
            const emit = this.buf.slice(0, this.buf.length - SUBMIT_KEEP);
            this.buf = this.buf.slice(this.buf.length - SUBMIT_KEEP);
            this.thinkingText += emit;
            out += emit;
          }
          return out;
        }
        const before = this.buf.slice(0, hit.index);
        this.thinkingText += before;
        out += before;
        this.buf = this.buf.slice(hit.index + hit.len);
        this.mode = "submit";
        continue;
      }

      this.submitText += this.buf;
      this.buf = "";
      // The structured protocol puts the audience note inside the payload, so a
      // model that skips the THINK draft would otherwise stream nothing at all.
      // Re-scanning the partial JSON is cheap (the payload is a few hundred
      // chars) and only runs on the noteField opt-in.
      if (this.options.noteField && !this.thinkingText.trim()) {
        const note = scanNoteField(this.submitText);
        if (note.length > this.noteStreamed) {
          out += note.slice(this.noteStreamed);
          this.noteStreamed = note.length;
        }
      }
      return out;
    }
  }

  /** True once the model has begun the submit block. */
  get sawSubmit(): boolean {
    return this.mode === "submit";
  }

  get thinking(): string {
    return this.thinkingText;
  }

  get raw(): string {
    return this.rawText;
  }

  finish(): {
    thinking: string;
    content: Record<string, unknown> | null;
    anomalies: string[];
  } {
    const anomalies: string[] = [];

    if (this.mode === "submit") {
      // payload already captured
    } else if (this.mode === "thinking") {
      if (this.buf) {
        this.thinkingText += this.buf;
        this.buf = "";
      }
      anomalies.push("missing_submit_marker");
      const salvaged = salvageObject(this.thinkingText);
      if (salvaged) {
        this.submitText = salvaged;
        this.thinkingText = this.thinkingText.slice(0, this.thinkingText.indexOf(salvaged)).trim();
        anomalies.push("submit_salvaged_from_prose");
      }
    } else {
      if (this.buf) {
        this.thinkingText += this.buf;
        this.buf = "";
      }
      anomalies.push("no_protocol_markers");
      const salvaged = salvageObject(this.thinkingText);
      if (salvaged) {
        this.submitText = salvaged;
        this.thinkingText = this.thinkingText.slice(0, this.thinkingText.indexOf(salvaged)).trim();
        anomalies.push("submit_salvaged_from_prose");
      }
    }

    const parsed = parseSubmitPayload(this.submitText);

    // A structured `note` is authoritative when the caller opted in: it survives a
    // model that skipped `<<<THINK>>>`, and it wins over a live draft.
    const jsonNote =
      this.options.noteField && parsed.content && typeof parsed.content.note === "string"
        ? parsed.content.note.trim()
        : "";
    if (jsonNote) {
      this.thinkingText = jsonNote;
    } else if (parsed.content && !this.thinkingText.trim()) {
      // Some models nest their reasoning inside the payload instead of before it.
      const inner = parsed.content.thinking ?? parsed.content.reasoning ?? parsed.content.thought;
      if (typeof inner === "string" && inner.trim()) this.thinkingText = inner.trim();
    }
    if (this.options.noteField && parsed.content && !this.thinkingText.trim()) {
      anomalies.push("missing_note");
    }

    if (parsed.error) anomalies.push(parsed.error);
    return {
      thinking: this.thinkingText.trim(),
      content: parsed.content,
      anomalies: [...new Set(anomalies)],
    };
  }
}

function salvageObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = text.lastIndexOf("}");
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

const NOTE_KEY = /"note"\s*:/;
const JSON_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/**
 * Pull the `note` string out of a submit payload that may still be arriving.
 * Returns whatever has been decoded so far: an incomplete escape or a missing
 * closing quote just stops the scan, and the next chunk resumes from there.
 */
function scanNoteField(text: string): string {
  const key = NOTE_KEY.exec(text);
  if (!key) return "";
  const open = text.indexOf('"', key.index + key[0].length);
  if (open < 0) return "";
  let out = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      const code = Number.parseInt(hex, 16);
      if (!Number.isNaN(code)) out += String.fromCharCode(code);
      i += 5;
      continue;
    }
    out += JSON_ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}

function looksLikeJsonStart(buf: string): boolean {
  const t = buf.replace(/^\s+/, "");
  if (t.length === 0) return false;
  return t[0] === "{" || t.startsWith("```");
}
