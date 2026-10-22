"use client";

import type { BoardMeter, BoardSpec } from "@/engine/types";

export interface BoardTeam {
  id: string;
  name: string;
  color: string;
}

export interface BoardStripProps {
  board: BoardSpec;
  teams: BoardTeam[];
  /** teamId → meter key → value (already clamped by the runtime). */
  values: Record<string, Record<string, number>>;
  /** teamId → meter key → value of the previous round, for the small delta. */
  prev?: Record<string, Record<string, number>>;
  stale: boolean;
  round: number;
}

const TONE: Record<string, string> = {
  jade: "var(--jade)",
  amber: "var(--amber)",
  blood: "var(--blood)",
  ghost: "var(--ghost)",
};

function position(meter: BoardMeter, value: number): number {
  const span = meter.max - meter.min || 1;
  const clamped = Math.min(meter.max, Math.max(meter.min, value));
  return ((clamped - meter.min) / span) * 100;
}

/** Same as position(), but keeps a 1px tick inside the box at both ends. */
function tickPosition(meter: BoardMeter, value: number): number {
  return Math.min(99.6, Math.max(0.4, position(meter, value)));
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function MeterBar({ meter, value, color }: { meter: BoardMeter; value: number; color: string }) {
  const zero = position(meter, 0);
  const at = position(meter, value);
  const left = Math.min(zero, at);
  const width = Math.abs(at - zero);
  const low = meter.threshold != null && value < meter.threshold;
  const fill = low ? TONE.blood : TONE[meter.tone ?? ""] ?? color;

  return (
    <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-ink-3">
      <div
        className="absolute inset-y-0 rounded-full transition-[width,left] duration-500"
        style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%`, backgroundColor: fill, opacity: 0.8 }}
      />
      {meter.threshold != null && (
        <span
          className="absolute inset-y-0 w-px bg-line-strong"
          style={{ left: `${position(meter, meter.threshold)}%` }}
          title={`临界 ${meter.threshold}`}
        />
      )}
      {zero > 0 && zero < 100 && (
        <span className="absolute inset-y-0 w-px bg-fg-faint/30" style={{ left: `${zero}%` }} />
      )}
    </div>
  );
}

function Track({
  meter,
  teams,
  values,
  marks,
}: {
  meter: BoardMeter;
  teams: BoardTeam[];
  values: Record<string, Record<string, number>>;
  marks: number[];
}) {
  return (
    <div className="rounded-md border border-line/60 bg-ink-0/30 px-3 pb-2 pt-2">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="label">{meter.label}</span>
        <span className="mono text-[10px] text-fg-faint">
          {meter.min} — {meter.max}
        </span>
      </div>
      <div className="relative h-9">
        <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-ink-3" />
        {marks.map((sq) => (
          <span
            key={sq}
            className="absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-amber/80"
            style={{ left: `${tickPosition(meter, sq)}%` }}
            title={`${sq} 阶`}
          />
        ))}
        {meter.threshold != null && (
          <span
            className="absolute top-1/2 h-4 w-px -translate-y-1/2 border-l border-dashed border-line-strong"
            style={{ left: `${tickPosition(meter, meter.threshold)}%` }}
          />
        )}
        {teams.map((team, i) => {
          const value = values[team.id]?.[meter.key] ?? meter.init;
          return (
            <span
              key={team.id}
              className="absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-ink-0 transition-[left] duration-500"
              style={{
                left: `${position(meter, value)}%`,
                top: i % 2 === 0 ? "4px" : "26px",
                backgroundColor: team.color,
              }}
              title={`${team.name} ${fmt(value)}`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
        {teams.map((team) => (
          <span key={team.id} className="mono text-[10px]" style={{ color: team.color }}>
            {team.name} {fmt(values[team.id]?.[meter.key] ?? meter.init)}
          </span>
        ))}
        {marks.length > 0 && <span className="mono ml-auto text-[10px] text-amber/80">雷位 {marks.join(" · ")}</span>}
      </div>
    </div>
  );
}

export function BoardStrip({ board, teams, values, prev, stale, round, marks = [] }: BoardStripProps & { marks?: number[] }) {
  if (!board) return null;
  const track = board.meters.find((m) => m.kind === "track");
  const others = board.meters.filter((m) => m.kind !== "track");

  return (
    <section className="panel mb-4 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="label">战况</span>
        {stale ? (
          <span className="mono text-[10px] text-amber/90">
            读数缺失 · 停在第 {round || 1} 轮
          </span>
        ) : round > 0 ? (
          <span className="mono text-[10px] text-fg-faint">第 {round} 轮读数</span>
        ) : (
          <span className="mono text-[10px] text-fg-faint">开局值</span>
        )}
      </div>

      <div className="space-y-2">
        {track && <Track meter={track} teams={teams} values={values} marks={marks} />}

        {others.map((meter) =>
          meter.kind === "count" ? (
            <div key={meter.key} className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="label w-14 shrink-0">{meter.label}</span>
              {teams.map((team) => {
                const value = values[team.id]?.[meter.key] ?? meter.init;
                const before = prev?.[team.id]?.[meter.key];
                const diff = before == null ? 0 : Number((value - before).toFixed(2));
                return (
                  <span key={team.id} className="flex items-baseline gap-1.5 text-[11px]">
                    <span className="text-fg-dim">{team.name}</span>
                    <span className="mono tabular-nums text-fg">{fmt(value)}</span>
                    <span className="mono text-[10px] text-fg-faint">/{meter.max}</span>
                    {diff !== 0 && (
                      <span className="mono text-[10px] text-fg-faint">
                        {diff > 0 ? "+" : ""}
                        {fmt(diff)}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          ) : (
            <div key={meter.key} className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
              <span className="label w-14 shrink-0">{meter.label}</span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1.5">
                {teams.map((team) => {
                  const value = values[team.id]?.[meter.key] ?? meter.init;
                  return (
                    <div key={team.id} className="flex min-w-[190px] flex-1 items-center gap-2">
                      <span className="w-12 shrink-0 truncate text-[11px]" style={{ color: team.color }}>
                        {team.name}
                      </span>
                      <MeterBar meter={meter} value={value} color={team.color} />
                      <span className="mono w-16 shrink-0 text-right text-[11px] tabular-nums text-fg-dim">
                        {fmt(value)}
                        <span className="text-fg-faint">/{meter.max}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ),
        )}
      </div>

      {board.meters.some((m) => m.threshold != null) && (
        <p className="mono mt-2 text-[10px] text-fg-faint">
          {board.meters
            .filter((m) => m.threshold != null)
            .map((m) => `${m.label} ${m.threshold} 为临界线`)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

/** Compact per-round chips for the round cards. */
export function StateChips({
  board,
  state,
  prevState,
}: {
  board?: BoardSpec | null;
  state?: Record<string, number> | null;
  prevState?: Record<string, number> | null;
}) {
  if (!board || !state) return null;
  const chips = board.meters
    .map((meter) => {
      const value = state[meter.key];
      if (typeof value !== "number") return null;
      const before = prevState?.[meter.key];
      const diff = typeof before === "number" ? Number((value - before).toFixed(2)) : 0;
      return (
        <span
          key={meter.key}
          className="rounded border border-line px-1.5 py-[1px] text-[10px] text-fg-faint"
          title={meter.label}
        >
          {meter.label}{" "}
          <span className="mono tabular-nums text-fg-dim">{fmt(value)}</span>
          {diff !== 0 && (
            <span className="mono text-[10px] text-fg-faint">
              {" "}
              ({diff > 0 ? "+" : ""}
              {fmt(diff)})
            </span>
          )}
        </span>
      );
    })
    .filter(Boolean);
  if (chips.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{chips}</div>;
}
