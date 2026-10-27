"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HEADER_NAV_CLASS } from "./SiteHeader";
import {
  clockLabel,
  filterMatches,
  kindLabel,
  matchHref,
  matchStatus,
  outcomeLabel,
  shortDateLabel,
  type CatalogMatch,
  type StatusTone,
} from "@/lib/match-catalog";

const DOT_CLASS: Record<StatusTone, string> = {
  jade: "bg-jade",
  amber: "bg-amber",
  blood: "bg-blood",
  dim: "bg-fg-faint",
};

/** Long lists stay usable without turning the dropdown into the whole page. */
const MAX_ROWS = 80;

/** Matches finish and start while you browse; a minute-old list is enough. */
const FRESH_MS = 60_000;

/**
 * The global "对局" menu: every match behind one search box, reachable from any page.
 *
 * Data is read on open and refreshed when it is older than a minute, so a match
 * started a moment ago still shows up. `Ctrl/⌘ K` toggles it; on phones the
 * button goes straight to the library page, where the search field has room.
 */
export function MatchMenu() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState<CatalogMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<CatalogMatch[] | null>(null);
  const fetchedAt = useRef(0);
  const inFlight = useRef(false);

  /**
   * Stale-while-revalidate: the last read paints instantly, anything older than
   * FRESH_MS is refreshed on open so a match started a minute ago still appears.
   * A failed refresh keeps the previous list instead of replacing it with an error.
   */
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch("/api/matches?limit=500", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { matches?: CatalogMatch[] };
      const next = Array.isArray(data.matches) ? data.matches : [];
      rowsRef.current = next;
      fetchedAt.current = Date.now();
      setRows(next);
    } catch {
      if (rowsRef.current === null) setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const stale = rowsRef.current === null || Date.now() - fetchedAt.current > FRESH_MS;
    if (stale) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  // ⌘K / Ctrl+K from anywhere that is not already a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      // Same rule as the button: on a phone the library page replaces the dropdown.
      if (window.matchMedia("(max-width: 639px)").matches) {
        router.push("/matches");
        return;
      }
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const filtered = useMemo(() => (rows ? filterMatches(rows, { query }) : []), [rows, query]);
  const shown = useMemo(() => filtered.slice(0, MAX_ROWS), [filtered]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, shown.length - 1)));
  }, [shown.length]);

  useEffect(() => {
    if (!open) return;
    const element = listRef.current?.querySelector('[data-active="true"]');
    element?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function go(match: CatalogMatch) {
    setOpen(false);
    router.push(matchHref(match));
  }

  // A 26rem dropdown does not fit a phone; the library page is the mobile menu.
  function toggleMenu() {
    if (window.matchMedia("(max-width: 639px)").matches) {
      router.push("/matches");
      return;
    }
    setOpen((value) => !value);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    // Arrows and Enter belong to the search field; buttons inside the panel keep
    // their native keyboard behaviour (Enter on the footer link must just link).
    if (event.target !== inputRef.current) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(0, shown.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, shown.length - 1));
      return;
    }
    if (event.key === "Enter") {
      const match = shown[active];
      if (match) {
        event.preventDefault();
        go(match);
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleMenu}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="所有对局 · Ctrl/⌘ K"
        className={`${HEADER_NAV_CLASS} inline-flex items-center gap-1 ${open ? "bg-ink-2 text-fg" : ""}`}
      >
        对局
        <span aria-hidden className="text-[9px] leading-none text-fg-faint">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="所有对局"
          onKeyDown={onKeyDown}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-line-strong bg-ink-1 shadow-[var(--shadow-pop)]"
        >
          <div className="border-b border-line px-2.5 py-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索对局"
              placeholder="搜索：规则 / 种子 / 胜方 / 状态"
              className="w-full rounded-md border border-line bg-ink-0 px-2.5 py-1.5 text-[12px] text-fg outline-none transition placeholder:text-fg-faint focus:border-jade/40"
            />
          </div>

          <div ref={listRef} className="max-h-[min(58vh,26rem)] overflow-auto py-1">
            {loading && rows === null && (
              <p className="px-3 py-6 text-center text-[12px] text-fg-faint">读取对局…</p>
            )}

            {!loading && failed && rows === null && (
              <div className="px-3 py-6 text-center text-[12px]">
                <p className="text-blood">读取失败</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-2 rounded border border-line px-2 py-1 text-[11px] text-fg-dim transition hover:border-jade/40 hover:text-jade"
                >
                  重试
                </button>
              </div>
            )}

            {!loading && !failed && rows && shown.length === 0 && (
              <p className="px-3 py-6 text-center text-[12px] text-fg-faint">没有匹配的对局</p>
            )}

            {!loading &&
              !failed &&
              shown.map((match, index) => {
                const status = matchStatus(match);
                return (
                  <button
                    key={match.id}
                    type="button"
                    data-active={index === active}
                    onClick={() => go(match)}
                    onMouseEnter={() => setActive(index)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left transition ${
                      index === active ? "bg-ink-3" : "hover:bg-ink-2/60"
                    }`}
                  >
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[status.tone]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">{match.rulesetName}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-fg-faint">
                        <span>{kindLabel(match.kind)}</span>
                        <span aria-hidden>·</span>
                        <span>{status.label}</span>
                        {match.status === "finished" && (
                          <>
                            <span aria-hidden>·</span>
                            <span>{outcomeLabel(match)}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="mono shrink-0 text-[10px] text-fg-faint">
                      {shortDateLabel(match.createdAt)} {clockLabel(match.createdAt)}
                    </span>
                  </button>
                );
              })}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <span className="text-[10px] text-fg-faint">
              {rows
                ? `共 ${filtered.length} 局${filtered.length > MAX_ROWS ? ` · 显示前 ${MAX_ROWS}` : ""} · ↑↓ 选择 · Enter 打开`
                : "Ctrl/⌘ K 随时打开"}
            </span>
            <Link
              href="/matches"
              onClick={() => setOpen(false)}
              className="text-[11px] text-jade transition hover:text-fg"
            >
              全部对局 →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
