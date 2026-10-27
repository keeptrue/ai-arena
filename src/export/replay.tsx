"use client";

import { createRoot } from "react-dom/client";
import { BrandMark, SiteHeader, StaticHeaderNav } from "@/components/SiteHeader";
import { WerewolfTable } from "@/components/WerewolfTable";
import type { TableExportPayload } from "@/lib/table-export";

/**
 * Boot the frozen replay inside an exported file.
 *
 * This module is bundled ahead of time into `public/export/replay.js` and
 * inlined by the export route. It shares the live table components on purpose:
 * the archive cannot drift from the site's UI.
 */

async function decodePayload(node: HTMLElement | null): Promise<TableExportPayload> {
  if (!node) throw new Error("缺少数据节点");
  const raw = (node.textContent ?? "").trim();
  const encoding = node.dataset.encoding ?? "json";
  if (encoding !== "gzip") return JSON.parse(raw) as TableExportPayload;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不支持解压，请重新导出并关闭 gzip 压缩");
  }
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as TableExportPayload;
}

function fail(root: HTMLElement, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const main = document.createElement("main");
  main.className = "mx-auto max-w-3xl px-6 py-24 text-center";
  const panel = document.createElement("p");
  panel.className = "panel px-5 py-8 text-[13px] leading-relaxed text-fg-dim";
  panel.textContent = `这份导出打不开：${message}`;
  const hint = document.createElement("p");
  hint.className = "mt-3 text-[11px] text-fg-faint";
  hint.textContent = "重新导出可以生成新的文件；如果文件来自旧版本，请让导出方更新后重试。";
  main.append(panel, hint);
  root.replaceChildren(main);
}

async function boot() {
  const root = document.getElementById("arena-export-root");
  if (!root) return;
  try {
    const payload = await decodePayload(document.getElementById("arena-export-data"));
    if (payload.v !== 1) throw new Error(`不认识的导出版本：${String(payload.v)}`);
    root.replaceChildren();
    createRoot(root).render(
      <>
        <SiteHeader
          brand={
            <span className="group flex items-center gap-2.5">
              <BrandMark />
            </span>
          }
          nav={<StaticHeaderNav />}
        />
        <WerewolfTable matchId={payload.match.id} snapshot={payload} />
      </>,
    );
  } catch (error) {
    fail(root, error);
  }
}

void boot();
