"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Header control for the offline export.
 *
 * The dropdown lives in a portal: `.ww-page` clips its overflow until the match
 * finishes, so an absolutely positioned panel inside the header would be cut off
 * on a running table. Position is fixed to the button's viewport rect.
 */
export function ExportMenu({ matchId }: { matchId: string }) {
  const [open, setOpen] = useState(false);
  const [reasoning, setReasoning] = useState(true);
  const [compress, setCompress] = useState(true);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function show() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", show);
    window.addEventListener("scroll", show, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", show);
      window.removeEventListener("scroll", show, true);
    };
  }, [open]);

  const href = `/api/matches/${matchId}/export?reasoning=${reasoning ? 1 : 0}&raw=${compress ? 0 : 1}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
      >
        导出 HTML
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="导出选项"
            style={{
              position: "fixed",
              top: pos.top,
              right: pos.right,
              zIndex: 60,
              backgroundColor: "var(--color-ink-1)",
            }}
            className="panel w-[248px] p-3 text-[12px] text-fg-dim shadow-xl"
          >
            <p className="label">导出为单文件</p>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(e) => setReasoning(e.target.checked)}
                className="mt-0.5 accent-[var(--color-jade)]"
              />
              <span>
                带模型推理原文
                <span className="mt-0.5 block text-[11px] text-fg-faint">关掉后只保留观众可见内容</span>
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={compress}
                onChange={(e) => setCompress(e.target.checked)}
                className="mt-0.5 accent-[var(--color-jade)]"
              />
              <span>
                gzip 压缩数据
                <span className="mt-0.5 block text-[11px] text-fg-faint">文件更小，需要现代浏览器</span>
              </span>
            </label>
            <a
              href={href}
              download
              onClick={() => setOpen(false)}
              className="mt-3 flex items-center justify-center rounded-md bg-jade px-3 py-2 text-[12px] font-medium text-ink-0 transition hover:bg-jade/90"
            >
              下载可交互版
            </a>
            <p className="mt-2 text-[10px] leading-relaxed text-fg-faint">
              离线打开即可回放；暂停、中止与评分等写操作不会带进去。
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
