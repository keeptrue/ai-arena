/**
 * Recover the spoken line from a model that broke protocol.
 *
 * Some models put the whole turn — markers, reasoning and JSON — into one blob,
 * and a single unescaped quote inside the speech is enough to make JSON.parse
 * fail. Dumping that blob into `speech` shows the audience the model's private
 * reasoning, so this helper walks the payload by hand and tolerates a truncated
 * value: it takes everything after the opening quote when no closing quote exists.
 *
 * Pure string work, no imports — safe for the reducer, the runtime and the UI.
 */

const SUBMIT_MARKERS = ["<<<SUBMIT>>>", "<<<SUBMIT>>", "<<SUBMIT>>", "<<<ACT>>>", "===SUBMIT==="];

export function salvageSpeech(raw: string): string {
  const source = String(raw ?? "");
  if (!source.trim()) return "";

  let cut = -1;
  for (const marker of SUBMIT_MARKERS) {
    const at = source.lastIndexOf(marker);
    if (at >= 0) cut = Math.max(cut, at + marker.length);
  }
  const body = cut >= 0 ? source.slice(cut) : source;

  let valueStart = -1;
  for (const match of body.matchAll(/"(?:speech|text)"\s*:\s*"/g)) {
    valueStart = (match.index ?? 0) + match[0].length;
  }
  if (valueStart >= 0) {
    let out = "";
    for (let i = valueStart; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\") {
        out += ch;
        if (i + 1 < body.length) {
          out += body[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return unescapeJsonString(out).trim();
  }

  const stripped = body
    .replace(/<<<[^>]*>>>/g, "\n")
    .replace(/===\s*(?:THINK|SUBMIT|ACT)\s*===/gi, "\n")
    .trim();
  // A payload object without a speech key is a malformed submission, not a line.
  if (!stripped || stripped.startsWith("{") || stripped.startsWith("[")) return "";
  return stripped;
}

function unescapeJsonString(text: string): string {
  return text
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}
