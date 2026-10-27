"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  PIN_EVENT,
  PIN_KEY,
  clearPin,
  isLivePin,
  loadPin,
  pinAfterPulse,
  pinPhaseLabel,
  pinProgress,
  pinVisibleOn,
  savePin,
  type MatchPin as Pin,
} from "@/lib/pin";

/** A live pin is one row read; 45s keeps the chip honest without being chatty. */
const PULSE_MS = 45_000;

/**
 * Header chip that walks you back to the match you were watching.
 *
 * Rendered from the root layout, so it survives client-side navigation; the record
 * itself lives in localStorage and is written by ArenaView.
 */
export function MatchPin() {
  const pathname = usePathname() ?? "/";
  const [pin, setPin] = useState<Pin | null>(null);
  const [mounted, setMounted] = useState(false);
  const pinRef = useRef<Pin | null>(null);

  function apply(next: Pin | null) {
    pinRef.current = next;
    setPin(next);
  }

  useEffect(() => {
    const sync = () => apply(loadPin());
    sync();
    setMounted(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === PIN_KEY || e.key === null) sync();
    };
    window.addEventListener(PIN_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PIN_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // The layout does not remount between routes; pathname is the signal that the
  // header now sits on a different page.
  useEffect(() => {
    apply(loadPin());
  }, [pathname]);

  const pinId = pin?.id ?? null;
  const pinPhase = pin?.phase ?? null;

  // Outside the arena the event stream is gone, so the stored snapshot is the only
  // thing we know. Ask the server for liveness, but only while this tab is visible.
  useEffect(() => {
    const current = pinRef.current;
    if (!pinId || !pinPhase || !current || !isLivePin(current) || !pinVisibleOn(pathname, current)) return;

    let alive = true;
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/matches/${encodeURIComponent(pinId)}/pulse`, { cache: "no-store" });
        if (!alive) return;
        if (res.status === 404) {
          clearPin(pinId);
          apply(loadPin());
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { status?: unknown; rounds?: unknown };
        if (!alive) return;
        const now = pinRef.current;
        if (!now || now.id !== pinId) return;
        const next = pinAfterPulse(now, data);
        if (next === now) return;
        apply(next);
        savePin(next);
      } catch {
        /* offline: the last known state is still worth showing */
      }
    };

    void ping();
    const timer = setInterval(() => void ping(), PULSE_MS);
    const onVisible = () => void ping();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, pinId, pinPhase]);

  if (!mounted || !pin || !pinVisibleOn(pathname, pin)) return null;

  const live = isLivePin(pin);
  const detail = [
    `上次看到 ${pinPhaseLabel(pin.phase)}`,
    pinProgress(pin),
    pin.kind === "werewolf" || pin.kind === "coup"
      ? `${pin.settled}/${pin.seats} 存活`
      : `${pin.settled}/${pin.seats} 就位`,
    new Date(pin.ts).toLocaleString("zh-CN", { hour12: false }),
  ].join(" · ");

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Link
        href={`/${pin.kind === "werewolf" ? "table" : pin.kind === "coup" ? "coup" : "arena"}/${pin.id}`}
        aria-label={`回到对局：${pin.name} · ${pinProgress(pin)}`}
        title={detail}
        className="flex min-w-0 items-center gap-2 rounded-md border border-jade/35 bg-jade/[0.06] px-2 py-1 text-[11px] transition hover:border-jade/60 hover:bg-jade/[0.12]"
      >
        <span
          aria-hidden
          className={
            live
              ? "live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-jade"
              : "h-1.5 w-1.5 shrink-0 rounded-full border border-fg-faint/70"
          }
        />
        <span className="max-w-[8.5rem] truncate text-fg">{pin.name}</span>
        <span className="mono shrink-0 text-[10px] text-jade/90">{pinProgress(pin)}</span>
        <span aria-hidden className="shrink-0 text-[10px] text-jade/70">
          ↩
        </span>
      </Link>
      <button
        type="button"
        onClick={() => {
          savePin(null);
          apply(null);
        }}
        title="从顶栏移除（进入对局会再次出现）"
        aria-label="从顶栏移除"
        className="flex h-6 w-5 items-center justify-center rounded text-[13px] leading-none text-fg-faint transition hover:bg-ink-2 hover:text-fg-dim"
      >
        ×
      </button>
    </div>
  );
}
