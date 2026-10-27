/**
 * Export a nine-seat match as a standalone HTML file.
 *
 * Pure by design: this module only reshapes the event stream and renders the
 * document shell. The route owns SQLite and gzip; the exported page owns React.
 * Keeping it free of `node:*` lets the browser bundle import the payload type.
 */

import type { ArenaEvent, ModelSnapshot } from "@/engine/types";

export const EXPORT_VERSION = 1;

/** Live-only events: the final text always lands in `seat.submitted` / `review.ballot`. */
const DROP_TYPES = new Set([
  "seat.thinking.delta",
  "judge.thinking.delta",
  "review.thinking.delta",
  "state.snapshot",
]);

export interface TableExportMatch {
  id: string;
  status: string;
  rulesetName: string;
  seed: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface TableExportParticipant {
  id: string;
  seat: number;
  model: ModelSnapshot;
}

export interface TableExportPayload {
  v: number;
  exportedAt: number;
  match: TableExportMatch;
  roster: { participants: TableExportParticipant[] };
  judge: ModelSnapshot | null;
  events: ArenaEvent[];
}

export interface CompactOptions {
  /**
   * Keep the provider's native reasoning channel. Turning it off drops only
   * `reasoning`; the audience note (`thinking`) and every other fact stay.
   */
  reasoning?: boolean;
}

export function isDroppedEvent(type: string): boolean {
  return DROP_TYPES.has(type);
}

/**
 * Drop the streaming tail. A finished match keeps every fact: deltas only feed
 * the live typewriter and `state.snapshot` is a recovery mirror, never replay.
 */
export function compactEvents(events: ArenaEvent[], opts: CompactOptions = {}): ArenaEvent[] {
  const keepReasoning = opts.reasoning !== false;
  const out: ArenaEvent[] = [];
  for (const event of events) {
    if (isDroppedEvent(event.type)) continue;
    if (!keepReasoning && event.type === "seat.submitted") {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.reasoning === "string" && payload.reasoning) {
        const { reasoning: _drop, ...rest } = payload;
        out.push({ ...event, payload: rest });
        continue;
      }
    }
    out.push(event);
  }
  return out;
}

/** `<` inside JSON would close the script tag; escaping keeps model text inert. */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** A literal `</script` anywhere in the bundle would end the inline script early. */
export function escapeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ExportHtmlOptions {
  title: string;
  css: string;
  js: string;
  /** Inline JSON string: base64(gzip(json)) or the escaped JSON itself. */
  data: string;
  encoding: "gzip" | "json";
  /** The same boot snippet the site layout runs before first paint. */
  themeBoot: string;
  /** Kept in an HTML comment for anyone reading the file by hand. */
  note?: string;
}

const LOADING_SKELETON =
  '<main class="mx-auto max-w-[1500px] px-6 py-10">' +
  '<div class="panel h-[420px] animate-pulse bg-ink-1/50"></div>' +
  "</main>";

/**
 * One document, no external references. The runtime is a classic script on
 * purpose: `type="module"` is blocked for local files by browser CORS rules.
 */
export function buildExportHtml(opts: ExportHtmlOptions): string {
  if (/<\/style/i.test(opts.css)) {
    throw new Error("compiled css contains a closing style tag");
  }
  const dataJson = opts.encoding === "json" ? escapeJsonForScript(opts.data) : opts.data;
  const note = opts.note ? `<!-- ${opts.note.replace(/--/g, "- -")} -->\n` : "";
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark" data-mode="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="斗场 · AI Arena">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(opts.title)}</title>
<style>
${opts.css}
</style>
</head>
<body class="min-h-screen antialiased">
${note}<div id="arena-export-root">${LOADING_SKELETON}</div>
<noscript>
<main class="mx-auto max-w-3xl px-6 py-24 text-center">
<p class="panel px-5 py-8 text-[13px] text-fg-dim">这份导出需要 JavaScript 才能展开。请用现代浏览器打开，或重新导出静态版本。</p>
</main>
</noscript>
<script type="application/json" id="arena-export-data" data-encoding="${opts.encoding}">${dataJson}</script>
<script>${opts.themeBoot}</script>
<script>${escapeInlineScript(opts.js)}</script>
</body>
</html>
`;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "unknown";
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

/** Filesystem- and header-safe: no separators, no control characters, bounded. */
export function sanitizeFilePart(raw: string, fallback = "match"): string {
  const text = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return text || fallback;
}

export function exportFileName(match: TableExportMatch): string {
  const when = stamp(match.finishedAt ?? match.createdAt ?? Date.now());
  const ruleset = sanitizeFilePart(match.rulesetName, "对局");
  const seed = sanitizeFilePart(match.seed, "");
  return `斗场-${ruleset}${seed ? `-${seed}` : ""}-${when}.html`;
}
