import { shuffle } from "../rng";
import { roleDeck } from "./blueprint";
import type { WerewolfBlueprint, WerewolfRoleId } from "./types";

/** Seeded deal: the same seed always produces the same nine cards. */
export function dealRoles(spec: WerewolfBlueprint, seed: string): WerewolfRoleId[] {
  return shuffle(roleDeck(spec), seed, "werewolf-deal");
}

/** How many alive seats are still on each side; used by the reducer and the UI. */
export function campCounts(seats: Array<{ alive: boolean; camp: "wolf" | "good" }>): {
  wolf: number;
  good: number;
} {
  let wolf = 0;
  let good = 0;
  for (const seat of seats) {
    if (!seat.alive) continue;
    if (seat.camp === "wolf") wolf += 1;
    else good += 1;
  }
  return { wolf, good };
}
