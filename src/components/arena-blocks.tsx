"use client";

import { useEffect, useRef, useState } from "react";
import { splitThinking, THINKING_LIMIT } from "@/lib/thinking";
import type { MemberView, SlotDef } from "./arena-parts";

/** Chinese labels for the reasoning ladder advertised by models.dev. */
export const EFFORT_LABEL: Record<string, string> = {
  none: "关思考",
  minimal: "极低思考",
  low: "低思考",
  medium: "中思考",
  high: "高思考",
  xhigh: "极高思考",
  max: "满思考",
};

/** Compact token counts: 987 → 987, 12_345 → 12.3k. */
function compactTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function EffortChip({ effort, budget }: { effort?: string | null; budget?: number | null }) {
  const label = effort ? EFFORT_LABEL[effort] ?? effort : budget ? "指定预算" : null;
  if (!label) return null;
  return (
    <span
      className="shrink-0 rounded border border-line px-1.5 py-[1px] text-[10px] leading-[1.6] text-fg-faint"
      title={budget ? `思考预算 ${budget} tokens` : "思考强度"}
    >
      {label}
      {budget ? ` · ${budget}` : ""}
    </span>
  );
}

/**
 * Second line of a seat card: real model identity on the left, what the call
 * cost on the right. Usage never truncates, so a long provider name cannot hide it.
 */
export function ModelMetaLine({ member }: { member: MemberView }) {
  const left = [
    member.modelId,
    member.kind,
    member.temperature != null ? `temp ${member.temperature}` : null,
  ].filter((b): b is string => Boolean(b));
  const right = [
    member.usage
      ? `↑${compactTokens(member.usage.promptTokens)} ↓${compactTokens(member.usage.completionTokens)}`
      : null,
    member.latencyMs != null ? `${(member.latencyMs / 1000).toFixed(1)}s` : null,
  ].filter((b): b is string => Boolean(b));

  if (left.length === 0 && right.length === 0) return null;
  return (
    <div className="flex items-baseline gap-2 px-3 pb-2 text-[10px] text-fg-faint" title={[...left, ...right].join(" · ")}>
      <span className="mono min-w-0 truncate">{left.join(" · ")}</span>
      {right.length > 0 && <span className="mono ml-auto shrink-0">{right.join(" · ")}</span>}
    </div>
  );
}

/* ── slot values: the actual move, rendered as fields ──────────────── */

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || (text.includes("\n") && text.length > 80);
  return (
    <div className="min-w-0">
      <div
        className={`whitespace-pre-wrap break-words text-[12px] leading-[1.7] text-fg ${
          long && !open ? "line-clamp-4" : ""
        }`}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[10px] text-fg-faint underline underline-offset-2 transition hover:text-fg-dim"
        >
          {open ? "收起" : `展开全文 · ${text.length} 字`}
        </button>
      )}
    </div>
  );
}

function SlotField({
  label,
  type,
  secret,
  value,
}: {
  label: string;
  type: "text" | "number" | "choice";
  secret: boolean;
  value: unknown;
}) {
  const empty = value === undefined || value === null || value === "";
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const stacked = !empty && type === "text" && (text.length > 60 || text.includes("\n"));

  const labelNode = (
    <span className="label inline-flex items-center gap-1">
      {label}
      {secret && (
        <span className="text-amber/70" title="暗项：对手看不到，只有裁判能读">
          🔒
        </span>
      )}
    </span>
  );

  if (empty) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        {labelNode}
        <span className="text-[12px] text-fg-faint">—</span>
      </div>
    );
  }

  if (type === "number") {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        {labelNode}
        <span className="mono text-[13px] tabular-nums text-fg">{text}</span>
      </div>
    );
  }

  if (type === "choice") {
    return (
      <div className="flex items-baseline justify-between gap-3 py-1.5">
        {labelNode}
        <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-fg">{text}</span>
      </div>
    );
  }

  if (stacked) {
    return (
      <div className="py-1.5">
        {labelNode}
        <div className="mt-1">
          <LongText text={text} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      {labelNode}
      <span className="min-w-0 break-words text-right text-[12px] text-fg">{text}</span>
    </div>
  );
}

/** Renders a submission as labelled fields; unknown keys from old rulesets still show up. */
export function SlotRows({
  slots,
  content,
}: {
  slots: SlotDef[];
  content: Record<string, unknown> | null | undefined;
}) {
  if (!content) return null;

  const entries = slots.length
    ? slots.map((s) => ({
        key: s.key,
        label: s.label,
        type: s.type,
        secret: s.reveal === "secret",
        value: content[s.key],
      }))
    : Object.keys(content).map((key) => ({
        key,
        label: key,
        type: "text" as const,
        secret: false,
        value: content[key],
      }));

  if (entries.length === 0) return <p className="py-1 text-[11px] text-fg-faint">（空提交）</p>;

  return (
    <div className="divide-y divide-line/50">
      {entries.map((entry) => (
        <SlotField
          key={entry.key}
          label={entry.label}
          type={entry.type}
          secret={entry.secret}
          value={entry.value}
        />
      ))}
    </div>
  );
}

/* ── thinking: its own surface, readable type, fold when long ──────── */

export function ThinkingBody({
  text,
  done,
  placeholder,
  autoScroll = false,
  limit = THINKING_LIMIT,
}: {
  text: string;
  done: boolean;
  placeholder: string;
  autoScroll?: boolean;
  /** How much of the note is shown before the reader asks for the rest. */
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, autoScroll]);

  if (!text) return <p className="text-[12px] leading-[1.8] text-fg-faint">{placeholder}</p>;

  const { head, rest, over } = splitThinking(text, limit);
  return (
    <div>
      <div
        ref={ref}
        className={`whitespace-pre-wrap break-words text-[12px] leading-[1.85] text-fg-dim ${
          expanded ? "max-h-[420px] overflow-y-auto" : ""
        }`}
      >
        {expanded ? text : head}
        {over && !expanded && <span className="text-fg-faint">…</span>}
        {!done && (
          <span className="ml-0.5 inline-block w-[5px] animate-pulse bg-fg-dim/60">&nbsp;</span>
        )}
      </div>
      {over && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-1 text-[10px] text-fg-faint underline underline-offset-2 transition hover:text-fg-dim"
        >
          {expanded ? `收起 · 只看前 ${limit} 字` : `展开全文 · 另 ${rest.length.toLocaleString("en-US")} 字`}
        </button>
      )}
    </div>
  );
}

export function ThinkingCount({ member }: { member: MemberView }) {
  const chars = member.thinking.join("").length;
  const over = chars > THINKING_LIMIT;
  const state =
    member.status === "thinking"
      ? "推演中"
      : member.status === "forfeit"
        ? "中断"
        : member.thinkingDone
          ? "已定稿"
          : "待命";
  return (
    <span className="mono text-[10px] text-fg-faint">
      {chars > 0 ? `${chars.toLocaleString("en-US")} 字${over ? " · 超 500" : ""} · ` : ""}
      {state}
    </span>
  );
}
