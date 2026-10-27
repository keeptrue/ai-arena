import { z } from "zod";
import { BlueprintError } from "../blueprint";
import { COUP_ROLES } from "./types";
import type { CoupBlueprint, CoupRoleSpec } from "./types";

const roleSchema = z.object({
  id: z.enum(COUP_ROLES),
  label: z.string().min(1).max(20),
  count: z.number().int().min(1).max(5),
});

const rulesSchema = z.object({
  startingCoins: z.number().int().min(1).max(5).default(2),
  coupCost: z.number().int().min(3).max(12).default(7),
  forcedCoupAt: z.number().int().min(5).max(20).default(10),
  stealCap: z.number().int().min(1).max(3).default(2),
  assassinateCost: z.number().int().min(1).max(5).default(3),
  deckExhausted: z.literal("draw_as_many").default("draw_as_many"),
  maxTurns: z.number().int().min(9).max(200).default(60),
});

const reviewWeightsSchema = z
  .object({
    bluff: z.number().min(0).max(1),
    read: z.number().min(0).max(1),
    tempo: z.number().min(0).max(1),
    poise: z.number().min(0).max(1),
  })
  .partial();

const reviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    selfWeight: z.number().min(0).max(1).optional(),
    judgeVotes: z.number().int().min(0).max(3).optional(),
    trim: z.boolean().optional(),
    minBallots: z.number().int().min(1).max(4).optional(),
    weights: reviewWeightsSchema.optional(),
  })
  .optional();

const commentarySchema = z
  .object({ modelId: z.string().min(1).max(80).nullable().optional() })
  .optional();

export const coupBlueprintSchema = z.object({
  mode: z.literal("coup"),
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能是小写字母/数字/连字符"),
  name: z.string().min(1).max(40),
  tagline: z.string().max(120).default(""),
  seats: z.literal(4),
  briefing: z.string().min(20, "规则正文太短，模型无法据此博弈"),
  roles: z.array(roleSchema).min(1).max(5),
  rules: rulesSchema.prefault({}),
  commentary: commentarySchema,
  review: reviewSchema,
});

/** Standard Coup: five roles, three copies each, fifteen cards total. */
const EXPECTED: Record<string, number> = {
  duke: 3,
  assassin: 3,
  captain: 3,
  ambassador: 3,
  contessa: 3,
};

export function parseCoupBlueprint(raw: unknown): CoupBlueprint {
  const parsed = coupBlueprintSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new BlueprintError("政变蓝图不合法", issues);
  }
  const bp = parsed.data as CoupBlueprint;
  validateRoles(bp.roles);
  validateRules(bp);
  return bp;
}

function validateRoles(roles: CoupRoleSpec[]): void {
  const seen = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.id)) throw new BlueprintError(`身份重复: ${role.id}`);
    seen.add(role.id);
    const expected = EXPECTED[role.id];
    if (expected === undefined) throw new BlueprintError(`未知身份: ${role.id}`);
    if (role.count !== expected) {
      throw new BlueprintError(`身份 ${role.id} 需要 ${expected} 张，当前 ${role.count} 张`);
    }
  }
  for (const id of COUP_ROLES) {
    if (!seen.has(id)) throw new BlueprintError(`缺少身份: ${id}`);
  }
  const total = roles.reduce((n, r) => n + r.count, 0);
  if (total !== 15) throw new BlueprintError(`总牌数必须是 15，当前 ${total}`);
}

function validateRules(bp: CoupBlueprint): void {
  const { coupCost, forcedCoupAt, startingCoins } = bp.rules;
  if (forcedCoupAt <= coupCost) {
    throw new BlueprintError(`强制政变线（${forcedCoupAt}）必须高于政变费用（${coupCost}）`);
  }
  if (startingCoins >= coupCost) {
    throw new BlueprintError(`起始金币（${startingCoins}）不该达到政变费用（${coupCost}）`);
  }
}

export function roleDeck(spec: CoupBlueprint): CoupRoleSpec[] {
  return spec.roles;
}

export function roleLabel(spec: CoupBlueprint, id: string): string {
  return spec.roles.find((r) => r.id === id)?.label ?? id;
}
