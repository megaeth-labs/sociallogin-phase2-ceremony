import { hexToBytes, keccak256, toHex } from "viem";
import { TRAITS, type TraitKey } from "./badge-svg";

export type Picks = Partial<Record<TraitKey, string>>;
export const TRAIT_KEYS = Object.keys(TRAITS) as TraitKey[];

/**
 * A made-up receipt hash from a fixed seed, with each picked trait's byte set
 * to the start of that option's range, so the contract draws it.
 */
export function forcedHash(seed: string, picks: Picks): string {
  const bytes = hexToBytes(keccak256(toHex(seed)));
  TRAIT_KEYS.forEach((key, i) => {
    const option = picks[key] ? TRAITS[key].names.indexOf(picks[key]) : -1;
    if (option >= 0) bytes[i] = TRAITS[key].weights.slice(0, option).reduce((a, b) => a + b, 0);
  });
  return toHex(bytes);
}

/** The gallery's rare #77, also shown among the homepage examples. */
export const CYBER_EYE_EXAMPLE = { index: 77, seed: "gallery-rare-1", picks: { eyes: "Cyber eye" } satisfies Picks };
