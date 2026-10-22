/**
 * Deterministic RNG.
 *
 * Every random number is derived from a 4-tuple hash (seed | round | seat | salt),
 * so values are order-independent — parallel actor calls cannot desynchronise a replay.
 */

export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit float in [0,1) that depends only on the tuple, never on call order. */
export function roll(seed: string, round: number, seat: number | string, salt: string): number {
  const h = fnv1a(`${seed}|${round}|${seat}|${salt}`);
  return mulberry32(h)();
}

/** Convenience: roll a value in [-1, 1] for damage variance. */
export function signedRoll(seed: string, round: number, seat: number | string, salt: string): number {
  return roll(seed, round, seat, salt) * 2 - 1;
}

export function pickIndex(seed: string, salt: string, len: number): number {
  return Math.floor(roll(seed, 0, "pick", salt) * len) % len;
}

/** Fisher-Yates seeded shuffle — used for seat assignment and blind maps. */
export function shuffle<T>(items: T[], seed: string, salt: string): T[] {
  const out = [...items];
  const rnd = mulberry32(fnv1a(`${seed}|shuffle|${salt}`));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function makeSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
