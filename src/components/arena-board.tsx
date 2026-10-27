"use client";

import type { BoardMeter, BoardSpec } from "@/engine/types";
import type { BoardSeriesPoint } from "@/lib/board";

export interface BoardTeam {
  id: string;
  name: string;
  color: string;
}

export interface ScoreboardProps {
  board: BoardSpec;
  teams: BoardTeam[];
  /** teamId → meter key → value (already the latest reading). */
  values: Record<string, Record<string, number>>;
  /** Per-round readings, for the trend line. Gaps stay gaps. */
  series: BoardSeriesPoint[];
  /** Rounds the board never reported. */
  missing: number[];
  round: number;
  rounds: number;
  stale: boolean;
}

const TONE: Record<string, string> = {
  jade: "var(--jade)",
  amber: "var(--amber)",
  blood: "var(--blood)",
  ghost: "var(--ghost)",
};

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function position(meter: BoardMeter, value: number): number {
  const span = meter.max - meter.min || 1;
  const clamped = Math.min(meter.max, Math.max(meter.min, value));
  return ((clamped - meter.min) / span) * 100;
}

/** Health-bar fill: from the floor of the declared range up to the value. */
function MeterBar({ meter, value, color }: { meter: BoardMeter; value: number; color: string }) {
  const at = position(meter, value);
  const low = meter.threshold != null && value < meter.threshold;
  const fill = low ? TONE.blood : TONE[meter.tone ?? ""] ?? color;
  const zero = meter.min < 0 && meter.max > 0 ? position(meter, 0) : null;

  return (
    <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-ink-3">
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(at, 0.8)}%`, backgroundColor: fill, opacity: low ? 0.95 : 0.75 }}
      />
      {meter.threshold != null && (
        <span
          className="absolute inset-y-0 w-px bg-fg/50"
          style={{ left: `${position(meter, meter.threshold)}%` }}
          title={`临界 ${meter.threshold}`}
        />
      )}
      {zero != null && (
        <span className="absolute inset-y-0 w-px bg-fg-faint/30" style={{ left: `${zero}%` }} />
      )}
    </div>
  );
}

/** Count meter as pips: `出卖` is a tally of knives, not a progress bar. */
function Pips({ meter, value, color }: { meter: BoardMeter; value: number; color: string }) {
  const total = Math.min(Math.max(Math.round(meter.max - meter.min), 1), 12);
  const filled = Math.min(total, Math.max(0, Math.round(value - meter.min)));
  return (
    <span className="inline-flex items-center gap-[3px]" title={`${value} / ${meter.max}`}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: i < filled ? color : "var(--ink-3)",
            opacity: i < filled ? 0.9 : 1,
          }}
        />
      ))}
      <span className="mono ml-1 text-[11px] tabular-nums text-fg-dim">{fmt(value)}</span>
    </span>
  );
}

function SideColumn({
  team,
  board,
  values,
}: {
  team: BoardTeam;
  board: BoardSpec;
  values: Record<string, number>;
}) {
  const bar = board.meters.find((m) => m.kind === "bar");
  const counts = board.meters.filter((m) => m.kind === "count");
  const others = board.meters.filter((m) => m.kind !== "bar" && m.kind !== "count");

  const hp = bar ? values[bar.key] ?? bar.init : null;
  const distance = bar?.threshold != null && hp != null ? Number((hp - bar.threshold).toFixed(2)) : null;
  const out = distance != null && distance < 0;

  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{
        borderColor: out ? "color-mix(in oklab, var(--blood) 45%, transparent)" : `${team.color}26`,
        background: out ? "color-mix(in oklab, var(--blood) 6%, transparent)" : "var(--ink-1)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: team.color }} />
          <span className="truncate text-[13px] font-semibold" style={{ color: team.color }}>
            {team.name}
          </span>
        </span>
        {hp != null && (
          <span className="mono shrink-0 text-[22px] leading-none tabular-nums" style={{ color: out ? TONE.blood : "var(--fg)" }}>
            {fmt(hp)}
            <span className="ml-0.5 text-[10px] text-fg-faint">/{bar!.max}</span>
          </span>
        )}
      </div>

      {bar && hp != null && (
        <div className="mt-2">
          <MeterBar meter={bar} value={hp} color={team.color} />
          <div className="mono mt-1 flex items-center justify-between text-[10px] text-fg-faint">
            <span>{bar.min}</span>
            {distance != null && (
              <span style={{ color: out ? TONE.blood : undefined }}>
                {out
                  ? `低于${bar.label}线 ${fmt(Math.abs(distance))}`
                  : `高出${bar.label}线 ${fmt(distance)}`}
              </span>
            )}
            <span>满 {bar.max}</span>
          </div>
        </div>
      )}

      {(counts.length > 0 || others.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {counts.map((meter) => (
            <span key={meter.key} className="flex items-center gap-1.5">
              <span className="label">{meter.label}</span>
              <Pips meter={meter} value={values[meter.key] ?? meter.init} color={team.color} />
            </span>
          ))}
          {others.map((meter) => (
            <span key={meter.key} className="flex items-center gap-1.5">
              <span className="label">{meter.label}</span>
              <span className="mono text-[12px] tabular-nums text-fg">{fmt(values[meter.key] ?? meter.init)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Blood over time: one line per side, a dashed release line, gaps where truth is missing. */
function BloodTrend({
  meter,
  teams,
  series,
  rounds,
}: {
  meter: BoardMeter;
  teams: BoardTeam[];
  series: BoardSeriesPoint[];
  rounds: number;
}) {
  if (series.length < 2) return null;

  const observed = series.flatMap((p) =>
    teams.map((t) => p.values[t.id]?.[meter.key]).filter((v): v is number => typeof v === "number"),
  );
  if (observed.length === 0) return null;

  // Zoom to the band the numbers actually live in (plus the release line): a full
  // -6…26 axis flattened every real swing into a straight line.
  const floor = Math.min(...observed, meter.threshold ?? Infinity);
  const ceiling = Math.max(...observed, meter.threshold ?? -Infinity);
  const pad = Math.max((ceiling - floor) * 0.15, 1);
  const lo = floor - pad;
  const hi = ceiling + pad;
  const span = hi - lo || 1;

  const x = (round: number) => (rounds > 1 ? ((round - 1) / (rounds - 1)) * 100 : 50);
  const y = (value: number) => 100 - ((Math.min(hi, Math.max(lo, value)) - lo) / span) * 100;

  const segments = teams.map((team) => {
    const points = series
      .map((p) => ({ round: p.round, value: p.values[team.id]?.[meter.key] }))
      .filter((p): p is { round: number; value: number } => typeof p.value === "number");
    const runs: Array<Array<{ round: number; value: number }>> = [];
    for (const point of points) {
      const last = runs[runs.length - 1];
      if (last && point.round - last[last.length - 1].round === 1) last.push(point);
      else runs.push([point]);
    }
    return { team, runs };
  });

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="label">{meter.label}走势</span>
        <span className="flex items-center gap-3">
          {teams.map((t) => (
            <span key={t.id} className="mono flex items-center gap-1 text-[10px]" style={{ color: t.color }}>
              <span className="h-[2px] w-3 rounded" style={{ backgroundColor: t.color }} />
              {t.name}
            </span>
          ))}
        </span>
      </div>
      <div className="relative h-16 w-full overflow-hidden rounded-md border border-line/50 bg-ink-0/40">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label={`${meter.label}走势`}>
          {[25, 50, 75].map((tick) => (
            <line key={tick} x1="0" x2="100" y1={tick} y2={tick} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity="0.5" />
          ))}
          {meter.threshold != null && (
            <line
              x1="0"
              x2="100"
              y1={y(meter.threshold)}
              y2={y(meter.threshold)}
              stroke="var(--blood)"
              strokeWidth="1"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              opacity="0.8"
            />
          )}
          {segments.map(({ team, runs }) =>
            runs.map((run, i) =>
              run.length > 1 ? (
                <polyline
                  key={`${team.id}-${i}`}
                  points={run.map((p) => `${x(p.round)},${y(p.value)}`).join(" ")}
                  fill="none"
                  stroke={team.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            ),
          )}
        </svg>
        {/* Dots live in HTML: a circle inside a non-uniformly scaled SVG renders as a smear. */}
        {segments.flatMap(({ team, runs }) =>
          runs.flatMap((run) =>
            run.map((p) => (
              <span
                key={`${team.id}-dot-${p.round}`}
                className="pointer-events-none absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-1"
                style={{
                  left: `${x(p.round)}%`,
                  top: `${y(p.value)}%`,
                  backgroundColor: team.color,
                  ["--tw-ring-color" as string]: "var(--ink-0)",
                }}
                title={`${team.name} 第 ${p.round} 轮 ${fmt(p.value)}`}
              />
            )),
          ),
        )}
        {meter.threshold != null && (
          <span
            className="mono pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-ink-0/80 px-1 text-[9px] text-blood"
            style={{ top: `${y(meter.threshold)}%` }}
          >
            {meter.threshold}
          </span>
        )}
      </div>
    </div>
  );
}

export function ArenaScoreboard({
  board,
  teams,
  values,
  series,
  missing,
  round,
  rounds,
  stale,
}: ScoreboardProps) {
  if (!board) return null;
  const bar = board.meters.find((m) => m.kind === "bar");

  return (
    <section className="panel mb-4 px-4 py-3.5">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="label">战况</span>
        <span className="mono text-[10px] text-fg-faint">
          {rounds > 0 ? `账面第 ${round} 轮 · 共 ${rounds} 轮` : "开局"}
          {stale && <span className="ml-2 text-amber/90">本轮读数缺失</span>}
          {missing.length > 0 && <span className="ml-2 text-amber/70">缺 {missing.map((r) => `R${r}`).join(" ")}</span>}
        </span>
      </div>

      <div className="grid gap-2.5 md:grid-cols-2">
        {teams.map((team) => (
          <SideColumn key={team.id} team={team} board={board} values={values[team.id] ?? {}} />
        ))}
      </div>

      {bar && <BloodTrend meter={bar} teams={teams} series={series} rounds={rounds} />}

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

/** One round's readings: board numbers only. Scores get their own row. */
export function ReadingChips({
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
      const bad = meter.threshold != null && value < meter.threshold;
      return (
        <span
          key={meter.key}
          className="rounded border border-line bg-ink-1/60 px-1.5 py-[1px] text-[10px]"
          style={bad ? { borderColor: "color-mix(in oklab, var(--blood) 40%, transparent)" } : undefined}
          title={before == null ? `${meter.label}：本轮读数` : `${meter.label}：${before} → ${value}`}
        >
          <span className="text-fg-faint">{meter.label} </span>
          <span className="mono tabular-nums text-fg">{fmt(value)}</span>
          {diff !== 0 && (
            <span className="mono ml-1" style={{ color: diff > 0 ? "var(--jade)" : "var(--blood)" }}>
              {diff > 0 ? "+" : ""}
              {fmt(diff)}
            </span>
          )}
        </span>
      );
    })
    .filter(Boolean);
  if (!chips.length) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{chips}</div>;
}

/** Rubric scores, deliberately quieter than the readings above them. */
export function ScoreChips({
  dimensions,
  values,
  weighted,
}: {
  dimensions: Array<{ key: string; label: string }>;
  values?: Record<string, number> | null;
  weighted?: number;
}) {
  if (!dimensions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {dimensions.map((d) => {
        const value = values?.[d.key];
        return (
          <span key={d.key} className="rounded px-1.5 py-[1px] text-[10px] text-fg-faint/80" title={`${d.label} 维度分`}>
            {d.label}
            <span className="mono ml-1 tabular-nums text-fg-faint">{Number.isFinite(value) ? value!.toFixed(1) : "—"}</span>
          </span>
        );
      })}
      {weighted != null && (
        <span className="mono ml-1 rounded border border-line/60 px-1.5 py-[1px] text-[10px] text-fg-faint">
          合计 {weighted.toFixed(2)}
        </span>
      )}
    </div>
  );
}
