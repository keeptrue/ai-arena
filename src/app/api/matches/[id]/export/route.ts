import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { ModelSnapshot } from "@/engine/types";
import { ensureSeedData, eventsAll, getMatch, getMatchJudge, getMatchRoster } from "@/db/repo";
import {
  EXPORT_VERSION,
  buildExportHtml,
  compactEvents,
  exportFileName,
  type TableExportPayload,
} from "@/lib/table-export";
import { THEME_BOOT } from "@/lib/theme-boot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_DIR = path.join(process.cwd(), "public", "export");
const JS_PATH = path.join(ASSET_DIR, "replay.js");
const CSS_PATH = path.join(ASSET_DIR, "replay.css");

/** Assets only change when `bun run export:build` rewrites them. */
let cached: { key: string; js: string; css: string } | null = null;

function loadAssets(): { js: string; css: string } {
  try {
    const key = `${statSync(JS_PATH).mtimeMs}:${statSync(CSS_PATH).mtimeMs}:${statSync(JS_PATH).size}:${statSync(CSS_PATH).size}`;
    if (cached?.key === key) return cached;
    cached = {
      key,
      js: readFileSync(JS_PATH, "utf8"),
      css: readFileSync(CSS_PATH, "utf8"),
    };
    return cached;
  } catch {
    throw new Error("导出资源未构建：先运行 `bun run export:build`");
  }
}

/**
 * The archive shows names and models, not the gateway URL. Keeping `baseUrl`
 * out of the file means a shared export cannot leak an internal endpoint.
 */
function publicModel(model: ModelSnapshot | null): ModelSnapshot | null {
  return model ? { ...model, baseUrl: "" } : null;
}

function oneOf(value: string | null, fallback: string): string {
  return value === null || value === "" ? fallback : value;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    ensureSeedData();
    const match = getMatch(id);
    if (!match) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const keepReasoning = oneOf(url.searchParams.get("reasoning"), "1") !== "0";
    const raw = oneOf(url.searchParams.get("raw"), "0") === "1";
    const preview = url.searchParams.get("preview") === "1";

    const events = eventsAll(id);
    const payload: TableExportPayload = {
      v: EXPORT_VERSION,
      exportedAt: Date.now(),
      match: {
        id: match.id,
        status: match.status,
        rulesetName: match.rulesetName,
        seed: match.seed,
        createdAt: match.createdAt,
        finishedAt: match.finishedAt,
      },
      roster: {
        participants: getMatchRoster(id).participants.map((p) => ({
          ...p,
          model: publicModel(p.model)!,
        })),
      },
      judge: publicModel(getMatchJudge(id)),
      events: compactEvents(events, { reasoning: keepReasoning }),
    };

    const json = JSON.stringify(payload);
    const data = raw ? json : gzipSync(Buffer.from(json), { level: 9 }).toString("base64");
    const encoding = raw ? "json" : "gzip";
    const assets = loadAssets();
    const html = buildExportHtml({
      title: `${match.rulesetName} · ${match.seed} · 斗场`,
      css: assets.css,
      js: assets.js,
      data,
      encoding,
      themeBoot: THEME_BOOT,
      note: `斗场导出 v${EXPORT_VERSION} · match ${match.id} · ${payload.events.length}/${events.length} events · ${encoding}`,
    });

    const filename = exportFileName(payload.match);
    const disposition = `${preview ? "inline" : "attachment"}; filename="arena-export.html"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": disposition,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[export] failed", id, error);
    const message = error instanceof Error ? error.message : "导出失败";
    return new Response(message, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
