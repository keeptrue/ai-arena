import { createHash } from "node:crypto";
import { z } from "zod";
import type { Blueprint, BlueprintSlot } from "./types";

export const MAX_ROUNDS = 20;
export const MAX_SLOTS = 4;
export const MAX_DIMENSIONS = 6;
export const MAX_BOARD_METERS = 6;

const slotSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, "slot key 必须是小写字母开头，只含字母/数字/下划线"),
  label: z.string().min(1).max(40),
  type: z.enum(["text", "number", "choice"]),
  choices: z.array(z.string().min(1)).max(12).optional(),
  required: z.boolean(),
  reveal: z.enum(["public", "secret"]),
  hint: z.string().max(200).optional(),
});

const dimensionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, "dimension key 必须是小写字母开头"),
  label: z.string().min(1).max(40),
  // Raw weights are normalised, so 40/35/25 and 2/2/1 both work.
  weight: z.number().positive().max(1000),
  hint: z.string().max(200).default(""),
});

const meterSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, "board meter key 必须是小写字母开头"),
  label: z.string().min(1).max(40),
  kind: z.enum(["bar", "count", "track"]),
  min: z.number().default(0),
  max: z.number(),
  init: z.number().optional(),
  threshold: z.number().optional(),
  tone: z.enum(["jade", "amber", "blood", "ghost"]).optional(),
});

const boardSchema = z.object({
  meters: z.array(meterSchema).min(1).max(MAX_BOARD_METERS),
  marks: z.object({ label: z.string().min(1).max(40) }).optional(),
});

export const blueprintSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能是小写字母/数字/连字符"),
  name: z.string().min(1).max(40),
  tagline: z.string().max(120).default(""),
  rounds: z.number().int().min(1).max(MAX_ROUNDS),
  briefing: z.string().min(20, "规则正文太短，模型无法据此博弈"),
  board: boardSchema.optional(),
  submission: z.object({ slots: z.array(slotSchema).min(1).max(MAX_SLOTS) }),
  rubric: z.object({ dimensions: z.array(dimensionSchema).min(2).max(MAX_DIMENSIONS) }),
  victory: z.object({
    type: z.literal("rubric_total"),
    tiebreaker: z.literal("sudden_death").default("sudden_death"),
    tieThreshold: z.number().min(0).max(3).default(0.5),
  }),
  judgeBrief: z.string().max(600).optional(),
});

export class BlueprintError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "BlueprintError";
  }
}

/** Validates and normalises: weights are rescaled to sum to 1. */
export function parseBlueprint(raw: unknown): Blueprint {
  const parsed = blueprintSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new BlueprintError("蓝图不合法", issues);
  }
  const bp = parsed.data as Blueprint;

  const slotKeys = new Set<string>();
  for (const slot of bp.submission.slots) {
    if (slotKeys.has(slot.key)) throw new BlueprintError(`槽位 key 重复: ${slot.key}`);
    slotKeys.add(slot.key);
    if (slot.type === "choice" && (!slot.choices || slot.choices.length === 0)) {
      throw new BlueprintError(`槽位 ${slot.key} 是 choice 类型但没有给选项`);
    }
  }

  const dimKeys = new Set<string>();
  for (const dim of bp.rubric.dimensions) {
    if (dimKeys.has(dim.key)) throw new BlueprintError(`评分维度 key 重复: ${dim.key}`);
    dimKeys.add(dim.key);
  }

  const sum = bp.rubric.dimensions.reduce((acc, d) => acc + d.weight, 0);
  if (!Number.isFinite(sum) || sum <= 0) throw new BlueprintError("评分权重之和必须为正");
  bp.rubric.dimensions = bp.rubric.dimensions.map((d) => ({
    ...d,
    weight: Number((d.weight / sum).toFixed(4)),
  }));

  if (bp.board) bp.board = normaliseBoard(bp.board);

  return bp;
}

/**
 * The board is display-only, but a broken spec would draw nonsense forever, so the
 * shape errors are caught here rather than in the UI.
 */
function normaliseBoard(board: NonNullable<Blueprint["board"]>): NonNullable<Blueprint["board"]> {
  const seen = new Set<string>();
  let tracks = 0;
  const meters = board.meters.map((m) => {
    if (seen.has(m.key)) throw new BlueprintError(`board 指标 key 重复: ${m.key}`);
    seen.add(m.key);
    if (!(m.max > m.min)) throw new BlueprintError(`board 指标 ${m.key} 的 max 必须大于 min`);
    if (m.kind === "track") tracks += 1;
    if (m.threshold != null && (m.threshold < m.min || m.threshold > m.max)) {
      throw new BlueprintError(`board 指标 ${m.key} 的 threshold 必须落在 min–max 之间`);
    }
    const init = m.init ?? m.min;
    if (init < m.min || init > m.max) {
      throw new BlueprintError(`board 指标 ${m.key} 的 init 必须落在 min–max 之间`);
    }
    return { ...m, init };
  });
  if (tracks > 1) throw new BlueprintError("board 最多只能有一条 track");
  if (board.marks && tracks === 0) {
    throw new BlueprintError("board.marks 需要一条 track 才有落点");
  }
  return { ...board, meters };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashBlueprint(bp: Blueprint): string {
  return createHash("sha256").update(canonical(bp)).digest("hex").slice(0, 16);
}

/* ── submission validation ─────────────────────────────────────────── */

export interface SlotValidation {
  ok: boolean;
  content: Record<string, unknown>;
  errors: string[];
}

/** Coerces and checks a raw submission against the blueprint's slots. */
export function validateSubmission(bp: Blueprint, raw: Record<string, unknown>): SlotValidation {
  const content: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const slot of bp.submission.slots) {
    const value = raw[slot.key];
    if (value === undefined || value === null || value === "") {
      if (slot.required) errors.push(`缺少必填槽位 ${slot.key}（${slot.label}）`);
      continue;
    }
    if (slot.type === "number") {
      const stripped = String(value).replace(/[^\d.\-+]/g, "");
      const n = typeof value === "number" ? value : stripped === "" ? NaN : Number(stripped);
      if (!Number.isFinite(n)) {
        errors.push(`槽位 ${slot.key} 需要数字，收到 ${JSON.stringify(value)}`);
        continue;
      }
      content[slot.key] = n;
      continue;
    }
    if (slot.type === "choice") {
      const text = String(value).trim();
      const hit = slot.choices?.find((c) => c === text || c.toLowerCase() === text.toLowerCase());
      if (!hit) {
        errors.push(`槽位 ${slot.key} 必须是 ${slot.choices?.join(" / ")} 之一，收到 ${text}`);
        continue;
      }
      content[slot.key] = hit;
      continue;
    }
    content[slot.key] = String(value).slice(0, 2000);
  }

  return { ok: errors.length === 0, content, errors };
}

export function slotByKey(bp: Blueprint, key: string): BlueprintSlot | undefined {
  return bp.submission.slots.find((s) => s.key === key);
}

export function publicSlots(bp: Blueprint): BlueprintSlot[] {
  return bp.submission.slots.filter((s) => s.reveal === "public");
}

/** A..H for teams, used as judge-facing labels. */
export function teamLetters(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
}
