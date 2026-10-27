import { z } from "zod";
import { BlueprintError } from "../blueprint";
import type { WerewolfBlueprint, WerewolfRoleId, WerewolfRoleSpec } from "./types";

const roleSchema = z.object({
  id: z.enum(["wolf", "seer", "witch", "hunter", "villager"]),
  label: z.string().min(1).max(20),
  camp: z.enum(["wolf", "good"]),
  count: z.number().int().min(1).max(9),
});

const witchSchema = z.object({
  antidote: z.number().int().min(0).max(1).default(1),
  poison: z.number().int().min(0).max(1).default(1),
  onePerNight: z.boolean().default(true),
  selfSave: z.enum(["first_night", "never", "always"]).default("first_night"),
  poisonSelf: z.boolean().default(false),
  seeKillAfterAntidote: z.boolean().default(true),
});

const hunterSchema = z.object({
  shootOn: z.array(z.enum(["wolf", "vote"])).min(1).max(2).default(["wolf", "vote"]),
  poisonBlocks: z.boolean().default(true),
});

const wolfSchema = z.object({
  allowEmptyKill: z.boolean().default(true),
  allowSelfKill: z.boolean().default(true),
  decision: z.literal("plurality").default("plurality"),
  tieBreak: z.literal("seed").default("seed"),
  chat: z.literal("sequential").default("sequential"),
});

const daySchema = z.object({
  speech: z.literal("clockwise").default("clockwise"),
  start: z.enum(["after_death", "fixed"]).default("after_death"),
  vote: z.literal("plurality").default("plurality"),
  tie: z.enum(["pk", "no_exile"]).default("pk"),
  pkVoters: z.enum(["non_candidates", "all"]).default("non_candidates"),
  lastWords: z.array(z.enum(["night1", "daytime"])).min(1).max(2).default(["night1", "daytime"]),
  selfDestruct: z.literal("own_speech").default("own_speech"),
  // 面杀标准：自爆后直接入夜，不留遗言。
  selfDestructLastWords: z.boolean().default(false),
  shotLastWords: z.boolean().default(false),
});

const rulesSchema = z.object({
  seerResult: z.literal("camp").default("camp"),
  witch: witchSchema.prefault({}),
  hunter: hunterSchema.prefault({}),
  wolf: wolfSchema.prefault({}),
  day: daySchema.prefault({}),
  maxDays: z.number().int().min(3).max(12).default(8),
});

const reviewWeightsSchema = z
  .object({
    read: z.number().min(0).max(1),
    voice: z.number().min(0).max(1),
    craft: z.number().min(0).max(1),
    poise: z.number().min(0).max(1),
  })
  .partial();

const reviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    selfWeight: z.number().min(0).max(1).optional(),
    judgeVotes: z.number().int().min(0).max(3).optional(),
    trim: z.boolean().optional(),
    minBallots: z.number().int().min(1).max(9).optional(),
    weights: reviewWeightsSchema.optional(),
  })
  .optional();

export const werewolfBlueprintSchema = z.object({
  mode: z.literal("werewolf"),
  id: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能是小写字母/数字/连字符"),
  name: z.string().min(1).max(40),
  tagline: z.string().max(120).default(""),
  seats: z.literal(9),
  briefing: z.string().min(20, "规则正文太短，模型无法据此博弈"),
  roles: z.array(roleSchema).min(1).max(9),
  rules: rulesSchema.prefault({}),
  review: reviewSchema,
});

/** The nine-seat deck is fixed by the board: 3 wolves, 3 villagers, seer/witch/hunter. */
const EXPECTED: Record<WerewolfRoleId, number> = {
  wolf: 3,
  villager: 3,
  seer: 1,
  witch: 1,
  hunter: 1,
};

const GOOD_GODS: WerewolfRoleId[] = ["seer", "witch", "hunter"];

export function parseWerewolfBlueprint(raw: unknown): WerewolfBlueprint {
  const parsed = werewolfBlueprintSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new BlueprintError("九人局蓝图不合法", issues);
  }
  const bp = parsed.data as WerewolfBlueprint;
  validateRoles(bp.roles);
  return bp;
}

function validateRoles(roles: WerewolfRoleSpec[]): void {
  const seen = new Set<string>();
  const counts: Partial<Record<WerewolfRoleId, number>> = {};
  for (const role of roles) {
    if (seen.has(role.id)) throw new BlueprintError(`身份重复: ${role.id}`);
    seen.add(role.id);
    counts[role.id] = role.count;
    const camp = role.id === "wolf" ? "wolf" : "good";
    if (role.camp !== camp) {
      throw new BlueprintError(`身份 ${role.id} 的阵营必须是 ${camp}`);
    }
  }
  const total = roles.reduce((n, r) => n + r.count, 0);
  if (total !== 9) throw new BlueprintError(`九人局身份总数必须是 9，当前 ${total}`);
  for (const [id, expected] of Object.entries(EXPECTED) as Array<[WerewolfRoleId, number]>) {
    if ((counts[id] ?? 0) !== expected) {
      throw new BlueprintError(`身份 ${id} 需要 ${expected} 张，当前 ${counts[id] ?? 0} 张`);
    }
  }
}

export function roleDeck(spec: WerewolfBlueprint): WerewolfRoleId[] {
  const deck: WerewolfRoleId[] = [];
  for (const role of spec.roles) {
    for (let i = 0; i < role.count; i++) deck.push(role.id);
  }
  return deck;
}

export function validateDeal(spec: WerewolfBlueprint, roles: WerewolfRoleId[]): string[] {
  const errors: string[] = [];
  if (roles.length !== spec.seats) {
    errors.push(`需要 ${spec.seats} 张身份，收到 ${roles.length} 张`);
    return errors;
  }
  const counts: Partial<Record<WerewolfRoleId, number>> = {};
  for (const id of roles) counts[id] = (counts[id] ?? 0) + 1;
  for (const role of spec.roles) {
    if ((counts[role.id] ?? 0) !== role.count) {
      errors.push(`${role.label} 需要 ${role.count} 张，收到 ${counts[role.id] ?? 0} 张`);
    }
  }
  return errors;
}

export function campOfRole(role: WerewolfRoleId): "wolf" | "good" {
  return role === "wolf" ? "wolf" : "good";
}

export function isGod(role: WerewolfRoleId): boolean {
  return GOOD_GODS.includes(role);
}

export function roleLabel(spec: WerewolfBlueprint, role: WerewolfRoleId): string {
  return spec.roles.find((r) => r.id === role)?.label ?? role;
}
