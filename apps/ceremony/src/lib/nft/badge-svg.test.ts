import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256, stringToHex, toHex } from "viem";
import { BADGE_ART_SOL_PATH, badgeArtSolidity } from "./badge-art-sol";
import { FUR_TONE, LIFT, badgeSvg, badgeTraits, bitPath, shortReceipt, TRAITS, traitIndices, type TraitKey } from "./badge-svg";

// Same receipt and index as packages/contribution-nft/test/ContributionBadge.t.sol.
const RECEIPT = keccak256(toHex("accepted-receipt"));
// Pinned in ContributionBadge.t.sol too: if either side's SVG drifts, both fail.
const BADGE_SVG_FIXTURE_KECCAK = "0xc53535c1c5dea89507dca20dbeb49ff0da19e90a89ab825c2bcd64d064505594";
// An obsidian coat on night moss, which takes the lifting haze; pinned in the forge test too.
const OBSIDIAN_RECEIPT = "0x03905a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const OBSIDIAN_SVG_FIXTURE_KECCAK = "0x60856272c4805e0b8b4334fc86f550d12e6eec5e56ed7b5a37c63c313bae83cb";
// Byte 9 = 0xf0 selects the rare glitched signal; pinned in the forge test too.
const GLITCH_RECEIPT = "0x5a5a5a5a5a5a5a5a5af05a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const GLITCH_SVG_FIXTURE_KECCAK = "0xc793a397dec45f3360f10d293c1672786871a5a3af0c01fe80603ed137fe939a";

describe("badgeSvg", () => {
  it("is byte-identical to the onchain artwork", () => {
    expect(keccak256(stringToHex(badgeSvg(7, RECEIPT)))).toBe(BADGE_SVG_FIXTURE_KECCAK);
  });
  it("hazes the background behind obsidian coats, matching the contract", () => {
    expect(badgeTraits(OBSIDIAN_RECEIPT).slice(0, 2).map((t) => t.value)).toEqual(["Night moss", "Obsidian"]);
    expect(badgeSvg(9, OBSIDIAN_RECEIPT)).toContain(LIFT);
    expect(badgeSvg(7, RECEIPT)).not.toContain(LIFT);
    expect(keccak256(stringToHex(badgeSvg(9, OBSIDIAN_RECEIPT)))).toBe(OBSIDIAN_SVG_FIXTURE_KECCAK);
  });
  it("draws the rare glitched signal over the grouped bunny, matching the contract", () => {
    expect(badgeTraits(GLITCH_RECEIPT).at(-1)?.value).toBe("Glitch");
    expect(badgeSvg(11, GLITCH_RECEIPT)).toContain('<use href="#u" x="24" clip-path="url(#xc)"/>');
    expect(keccak256(stringToHex(badgeSvg(11, GLITCH_RECEIPT)))).toBe(GLITCH_SVG_FIXTURE_KECCAK);
  });
  it("tones every glass and draws no silhouette outlines", () => {
    expect(FUR_TONE).toHaveLength(TRAITS.fur.weights.length);
    expect(badgeSvg(9, OBSIDIAN_RECEIPT)).not.toContain('stroke="url(#o)"');
  });

  it("matches the committed Solidity library", () => {
    const committed = readFileSync(resolve(__dirname, "../../../../..", BADGE_ART_SOL_PATH), "utf8");
    expect(committed, "run generate:badge-art").toBe(badgeArtSolidity());
  });

  it("reads the same traits the contract reports", () => {
    expect(badgeTraits(RECEIPT).map((t) => t.value)).toEqual([
      "Greenhouse glass", "Pale gold", "Ink tipped", "Techwear", "Brow LEDs", "Side glance", "None", "LED collar", "Moss green", "Clean",
    ]);
  });

  it("draws one strip cell per set bit, most significant first", () => {
    const bits = BigInt(RECEIPT).toString(2).split("").filter((b) => b === "1").length;
    expect(bitPath(RECEIPT).split("M").length - 1).toBe(bits);
    expect(bitPath(`0x8${"0".repeat(63)}`)).toBe("M64 572h3v3h-3z");
    expect(bitPath(`0x${"0".repeat(63)}1`)).toBe("M572 576h3v3h-3z");
  });

  it("shortens the receipt like the contract", () => {
    expect(shortReceipt(RECEIPT)).toBe("0x91f1d492...3cd6971d");
  });

  it("shows an unrevealed silhouette before a receipt exists", () => {
    const svg = badgeSvg(128);
    expect(svg).toContain("HATCHES FROM YOUR RECEIPT");
    expect(svg).toContain("MOSS #128");
  });

  it("never draws the two halves of the face differently", () => {
    expect(TRAITS.marking.names).not.toContain("Split face");
    expect(TRAITS.eyes.names).not.toContain("Heterochromia");
  });

  it("keeps every weight table summing to 256 with art for each option", () => {
    for (const trait of Object.values(TRAITS)) {
      expect(trait.weights.reduce((a, b) => a + b, 0)).toBe(256);
      expect(trait.art).toHaveLength(trait.weights.length);
      expect(trait.names).toHaveLength(trait.weights.length);
      if (trait.front) expect(trait.front).toHaveLength(trait.weights.length);
    }
  });

  it("hands out traits at their documented rarity", () => {
    const samples = 20_000;
    const counts = Object.fromEntries(
      Object.entries(TRAITS).map(([key, trait]) => [key, trait.weights.map(() => 0)]),
    ) as Record<TraitKey, number[]>;
    let seed = keccak256(toHex("rarity"));
    for (let i = 0; i < samples; i++) {
      seed = keccak256(seed);
      const picked = traitIndices(seed);
      for (const key of Object.keys(counts) as TraitKey[]) counts[key][picked[key]]++;
    }
    for (const [key, trait] of Object.entries(TRAITS) as [TraitKey, (typeof TRAITS)[TraitKey]][])
      trait.weights.forEach((weight, i) => {
        expect(Math.abs(counts[key][i] / samples - weight / 256)).toBeLessThan(0.015);
      });
  });
});
