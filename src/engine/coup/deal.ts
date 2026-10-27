/**
 * Deterministic deal for the Coup table.
 *
 * Fifteen cards, five roles × three copies. The shuffle is derived from the
 * match seed, so the same seed always produces the same hands — a replay needs
 * no stored deck.
 */

import { shuffle } from "../rng";
import { COUP_ROLES } from "./types";
import type { CoupCard, CoupRole } from "./types";

interface RawCard {
  role: CoupRole;
  copy: number;
}

export function buildDeck(): RawCard[] {
  const deck: RawCard[] = [];
  for (const role of COUP_ROLES) {
    for (let copy = 0; copy < 3; copy++) deck.push({ role, copy });
  }
  return deck;
}

/**
 * Deal two cards to each seat, in seat order, leaving the rest as the court deck.
 * Card ids are assigned *after* the shuffle so they are stable across replays.
 */
export function dealCards(
  seed: string,
  seatCount: number,
): { hands: CoupCard[][]; deck: CoupCard[] } {
  if (seatCount < 2 || seatCount > 6) {
    throw new Error(`人数必须在 2–6 之间，收到 ${seatCount}`);
  }
  const mixed = shuffle(buildDeck(), seed, "coup:deal");
  const cards: CoupCard[] = mixed.map((card, i) => ({
    id: `c${String(i + 1).padStart(2, "0")}`,
    role: card.role,
  }));

  const hands: CoupCard[][] = Array.from({ length: seatCount }, () => []);
  let cursor = 0;
  for (let round = 0; round < 2; round++) {
    for (let seat = 0; seat < seatCount; seat++) {
      hands[seat].push(cards[cursor++]);
    }
  }
  return { hands, deck: cards.slice(cursor) };
}

/** Roles a seat still holds face down. */
export function heldRoles(cards: CoupCard[]): CoupRole[] {
  return cards.map((c) => c.role);
}

/** Does this seat hold a face-down copy of `role`? */
export function holds(cards: CoupCard[], role: CoupRole | null): boolean {
  if (!role) return false;
  return cards.some((c) => c.role === role);
}
