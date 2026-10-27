import { BlueprintError, parseBlueprint } from "./blueprint";
import { parseWerewolfBlueprint } from "./werewolf/blueprint";
import { parseCoupBlueprint } from "./coup/blueprint";
import type { AnyBlueprint, Blueprint, GameKind } from "./types";

/** Dispatch on the payload's `mode`; anything else keeps the original rubric path. */
export function parseAnyBlueprint(raw: unknown): AnyBlueprint {
  if (raw && typeof raw === "object" && "mode" in raw) {
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === "werewolf") return parseWerewolfBlueprint(raw);
    if (mode === "coup") return parseCoupBlueprint(raw);
    if (mode !== undefined && mode !== "rubric") {
      throw new BlueprintError(`未知的对局类型: ${String(mode)}`);
    }
  }
  return parseBlueprint(raw);
}

export function gameKindOf(bp: AnyBlueprint): GameKind {
  if (bp.mode === "werewolf") return "werewolf";
  if (bp.mode === "coup") return "coup";
  return "rubric";
}

export function isWerewolfBlueprint(bp: AnyBlueprint): bp is Extract<AnyBlueprint, { mode: "werewolf" }> {
  return bp.mode === "werewolf";
}

export function isCoupBlueprint(bp: AnyBlueprint): bp is Extract<AnyBlueprint, { mode: "coup" }> {
  return bp.mode === "coup";
}

/** Everything that is not a structured table game goes down the rubric path. */
export function isRubricBlueprint(bp: AnyBlueprint): bp is Blueprint {
  return bp.mode !== "werewolf" && bp.mode !== "coup";
}

/** A single line for cards and logs, without forcing the caller to narrow the union. */
export function blueprintMeta(bp: AnyBlueprint): {
  kind: GameKind;
  rounds: number;
  seats: number;
  tagline: string;
} {
  if (bp.mode === "werewolf") {
    return { kind: "werewolf", rounds: bp.rules.maxDays, seats: bp.seats, tagline: bp.tagline };
  }
  if (bp.mode === "coup") {
    return { kind: "coup", rounds: bp.rules.maxTurns, seats: bp.seats, tagline: bp.tagline };
  }
  return { kind: "rubric", rounds: bp.rounds, seats: 0, tagline: bp.tagline };
}

export type { AnyBlueprint, Blueprint };
