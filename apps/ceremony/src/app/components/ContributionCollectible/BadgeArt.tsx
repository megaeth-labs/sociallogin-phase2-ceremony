import { badgeDataUri, badgeTraits } from "@/lib/nft/badge-svg";
import styles from "./style.module.css";

export function badgeAlt(index?: number, receiptHash?: string): string {
  if (!receiptHash)
    return `MOSS contributor${index ? ` #${index}` : ""} bunny, not yet revealed: a dark glass silhouette that takes its traits from your receipt`;
  // Lower-case trait names for the sentence, keeping LED as an acronym.
  const traits = Object.fromEntries(
    badgeTraits(receiptHash).map((t) => [t.trait_type, t.value.toLowerCase().replace(/\bled(s?)\b/g, "LED$1")]),
  );
  const color = traits["Eye color"];
  const eyes =
    traits.Eyes === "shades" ? "wearing shades"
    : traits.Eyes === "visor" ? `a ${color} visor`
    : traits.Eyes === "neon glow" ? "glowing neon eyes"
    : traits.Eyes === "cyber eye" ? `a ${color} cyber eye implant`
    : `${traits.Eyes} ${color} eyes`;
  const article = (thing: string) =>
    thing.endsWith("s") ? thing : /^(LED|[aeiou])/.test(thing) ? `an ${thing}` : `a ${thing}`;
  const extras = [
    traits.Outfit !== "none" && `wearing ${article(traits.Outfit)}`,
    traits.Headwear !== "none" && `with ${article(traits.Headwear)}`,
    traits.Neckwear !== "none" && `with ${article(traits.Neckwear)}`,
    traits.Marking !== "none" && `with ${article(traits.Marking)}`,
    traits.Signal === "glitch" && "grinning wide and glitching on a broken signal",
  ].filter(Boolean);
  const ears = traits.Ears === "one lop" ? "one lop ear" : `${traits.Ears} ears`;
  const glass = /glass|crystal/.test(traits.Glass) ? traits.Glass : `${traits.Glass} glass`;
  return `MOSS contributor #${index} bunny in ${glass}: ${ears}, ${eyes}${extras.length ? `, ${extras.join(", ")}` : ""}, on a ${traits.Background} background`;
}

/** Renders the exact SVG the contract serves, so the preview matches the mint. */
export function BadgeArt({ index, receiptHash, className }: { index?: number; receiptHash?: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a data URI keeps the bytes identical to tokenURI
    <img
      className={`${styles.art} ${className ?? ""}`}
      src={badgeDataUri(index, receiptHash)}
      width="640"
      height="640"
      alt={badgeAlt(index, receiptHash)}
    />
  );
}

/** The bunny's traits as a compact list, read from the same receipt hash. */
export function BadgeTraits({ receiptHash }: { receiptHash: string }) {
  return (
    <dl className={styles.traits} aria-label="Collectible traits">
      {badgeTraits(receiptHash).map((trait) => (
        <div key={trait.trait_type}>
          <dt>{trait.trait_type}</dt>
          <dd>{trait.value}</dd>
        </div>
      ))}
    </dl>
  );
}
