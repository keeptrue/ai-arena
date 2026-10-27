/**
 * The "don't lose the match" pin.
 *
 * Only the arena page knows which match is on screen; every other page knows nothing.
 * This module is the bridge: one localStorage record, plus the rules for when a new
 * sighting may replace it. Everything except the two window-guarded storage helpers is
 * pure, so the replacement rules stay testable without a DOM.
 */

export const PIN_KEY = "arena-pin";
/** Same-tab broadcast; other tabs get the native `storage` event. */
export const PIN_EVENT = "arena:pin-changed";
/** Old enough to be noise, new enough to be "the match I was watching". */
export const PIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type PinPhase = "connecting" | "collecting" | "judging" | "playing" | "paused" | "done";

export interface MatchPin {
  id: string;
  /** Which table the chip should reopen. Old records default to the rubric arena. */
  kind: "rubric" | "werewolf" | "coup";
  name: string;
  phase: PinPhase;
  /** Rounds the judge has closed. */
  round: number;
  /** Rounds the blueprint planned. 0 = unknown. */
  rounds: number;
  /** Seats that had submitted or forfeited when this record was written. */
  settled: number;
  seats: number;
  ts: number;
}

const PHASES: readonly PinPhase[] = ["connecting", "collecting", "judging", "playing", "paused", "done"];
const MAX_NAME = 80;

function isPhase(value: unknown): value is PinPhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/** Non-negative finite integer, or null. Rejects strings and NaN on purpose. */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Strict reader: anything that does not look exactly like a pin is treated as absent.
 * A stale or corrupt record must never break the header for every page.
 */
export function parsePin(raw: string | null, now = Date.now()): MatchPin | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const src = data as Record<string, unknown>;

  const id = typeof src.id === "string" ? src.id.trim() : "";
  const kind = src.kind === "werewolf" ? "werewolf" : src.kind === "coup" ? "coup" : "rubric";
  const name = typeof src.name === "string" ? src.name.trim().slice(0, MAX_NAME) : "";
  if (!id || !name || !isPhase(src.phase)) return null;

  const round = count(src.round);
  const rounds = count(src.rounds);
  const settled = count(src.settled);
  const seats = count(src.seats);
  const ts = count(src.ts);
  if (round === null || rounds === null || settled === null || seats === null || ts === null) return null;
  if (ts <= 0 || now - ts > PIN_TTL_MS) return null;

  return {
    id,
    kind,
    name,
    phase: src.phase,
    round,
    rounds,
    settled: seats > 0 ? Math.min(settled, seats) : settled,
    seats,
    ts,
  };
}

/** A pin that is not finished; the only kind worth polling. */
export function isLivePin(pin: MatchPin): boolean {
  return pin.phase !== "done";
}

/**
 * Compare everything that is visible. `ts` is a heartbeat, not a fact: streaming a
 * round must not rewrite the record when nothing readable changed.
 */
export function samePin(a: MatchPin, b: MatchPin): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.name === b.name &&
    a.phase === b.phase &&
    a.round === b.round &&
    a.rounds === b.rounds &&
    a.settled === b.settled &&
    a.seats === b.seats
  );
}

/**
 * Which sighting wins:
 * - nothing pinned → the new one;
 * - same match → the fresher one;
 * - a live match is never displaced by an archived one (you can watch an old
 *   replay without losing the round that is running right now);
 * - otherwise the newest sighting wins.
 */
export function decidePin(prev: MatchPin | null, next: MatchPin): MatchPin | null {
  if (!prev) return next;
  if (samePin(prev, next)) return prev;
  if (prev.id === next.id) return next;
  if (isLivePin(next)) return next;
  if (!isLivePin(prev)) return next;
  return prev;
}

/** Hide the chip on the very page it points at; keep it everywhere else. */
export function pinVisibleOn(pathname: string, pin: MatchPin | null): boolean {
  if (!pin) return false;
  const path = (pathname || "").replace(/\/+$/, "") || "/";
  const home =
    pin.kind === "werewolf" ? `/table/${pin.id}` : pin.kind === "coup" ? `/coup/${pin.id}` : `/arena/${pin.id}`;
  return path !== home;
}

export function pinProgress(pin: MatchPin): string {
  return `${pin.round}/${pin.rounds > 0 ? pin.rounds : "?"} ${pin.kind === "werewolf" ? "天" : "轮"}`;
}

export function pinPhaseLabel(phase: PinPhase): string {
  const map: Record<PinPhase, string> = {
    connecting: "连接中",
    collecting: "出招中",
    judging: "裁决中",
    playing: "对局中",
    paused: "已暂停",
    done: "已终局",
  };
  return map[phase];
}

/**
 * Fold a `/api/matches/[id]/pulse` answer into the pin. The stored pin stays the
 * source of truth for name/total rounds; the pulse only refreshes liveness and the
 * closed-round count. Unknown statuses are ignored rather than guessed.
 */
export function pinAfterPulse(
  pin: MatchPin,
  pulse: { status?: unknown; rounds?: unknown },
  now = Date.now(),
): MatchPin {
  const status = typeof pulse.status === "string" ? pulse.status : "";
  const reported = count(pulse.rounds);
  const round = reported === null ? pin.round : Math.max(pin.round, reported);
  const phase: PinPhase = status && status !== "running" ? "done" : pin.phase;
  if (phase === pin.phase && round === pin.round) return pin;
  return { ...pin, phase, round, ts: now };
}

/* ── storage: guarded, silent, never throws ─────────────────────────── */

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPin(now = Date.now()): MatchPin | null {
  const store = storage();
  if (!store) return null;
  try {
    return parsePin(store.getItem(PIN_KEY), now);
  } catch {
    return null;
  }
}

export function savePin(pin: MatchPin | null): void {
  const store = storage();
  if (store) {
    try {
      if (pin) store.setItem(PIN_KEY, JSON.stringify(pin));
      else store.removeItem(PIN_KEY);
    } catch {
      /* private mode / quota: the chip simply stays absent */
    }
  }
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PIN_EVENT));
  } catch {
    /* no window, nothing to notify */
  }
}

/** Drop the record, optionally only when it still points at `id`. */
export function clearPin(id?: string): void {
  const current = loadPin();
  if (id && current && current.id !== id) return;
  savePin(null);
}

/** Called by the arena page: apply the replacement rules, then persist. */
export function publishPin(next: MatchPin): void {
  const prev = loadPin();
  const chosen = decidePin(prev, next);
  if (chosen === prev) return;
  savePin(chosen);
}
