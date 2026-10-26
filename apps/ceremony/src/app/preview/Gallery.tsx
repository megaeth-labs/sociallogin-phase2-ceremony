"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { keccak256, toHex } from "viem";
import { BadgeArt, BadgeTraits } from "@/app/components/ContributionCollectible";
import { collectibleReceiptHash } from "@/lib/api";
import { badgeDataUri, shortReceipt, TRAITS } from "@/lib/nft/badge-svg";
import { CYBER_EYE_EXAMPLE, forcedHash, TRAIT_KEYS, type Picks } from "@/lib/nft/forced-traits";
import { getRehearsalHistory } from "@/lib/rehearsal-history";
import card from "@/app/components/ContributionCollectible/style.module.css";
import styles from "./gallery.module.css";

type Bunny = { key: string; index: number; hash: string; by?: string; note?: string };

/** Contribution numbers for the example slots, spread across a full ceremony. */
const EXAMPLE_INDICES = [12, 31, 47, 64, 88, 103, 128, 156, 201, 248, 312, 420];

/**
 * Made-up receipt hashes: keccak256 of fixed seeds at first, so the page
 * loads the same way each time, then random ones on every shuffle.
 */
function examples(round: number): Bunny[] {
  return EXAMPLE_INDICES.map((index, i) => ({
    key: `${round}-${i}`,
    index,
    hash: round === 0 ? keccak256(toHex(`gallery-${i}`)) : toHex(crypto.getRandomValues(new Uint8Array(32))),
  }));
}

/** Chance out of 256, as the contract reads one hash byte per trait. */
function odds(weight: number) {
  const percent = (weight / 256) * 100;
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

/** Rare options on show, each forced onto an otherwise seeded hash; the last stacks several. */
const RARE: { index: number; title: string; picks: Picks }[] = [
  { index: 7, title: "Glitch signal", picks: { signal: "Glitch" } },
  { index: CYBER_EYE_EXAMPLE.index, title: "Cyber eye", picks: CYBER_EYE_EXAMPLE.picks },
  { index: 101, title: "Drone", picks: { headwear: "Drone" } },
  { index: 256, title: "Opal glass", picks: { fur: "Opal" } },
  { index: 404, title: "Neon bloom", picks: { background: "Neon bloom" } },
  { index: 512, title: "Glass armor", picks: { outfit: "Glass armor" } },
  { index: 777, title: "Neon glow eyes", picks: { eyes: "Neon glow" } },
  { index: 1024, title: "Circuit lines", picks: { marking: "Circuit lines" } },
  {
    index: 1337,
    title: "Six rare traits at once",
    picks: { background: "Neon bloom", fur: "Opal", outfit: "Glass armor", eyes: "Cyber eye", headwear: "Drone", signal: "Glitch" },
  },
];

/** The chance a bunny has every picked trait: a percentage, or "1 in N" when it is small. */
function chance(picks: Picks): string {
  const p = TRAIT_KEYS.reduce((acc, key) => {
    const option = picks[key] ? TRAITS[key].names.indexOf(picks[key]) : -1;
    return option >= 0 ? acc * (TRAITS[key].weights[option] / 256) : acc;
  }, 1);
  if (p >= 0.01) return `${(p * 100).toFixed(1)}% of bunnies`;
  const n = new Intl.NumberFormat("en", { notation: "compact", compactDisplay: "long", maximumSignificantDigits: 2 }).format(1 / p);
  return `about 1 in ${n}`;
}

const RARE_BUNNIES: Bunny[] = RARE.map(({ index, title, picks }, i) => ({
  key: `rare-${i}`,
  index,
  hash: forcedHash(`gallery-rare-${i}`, picks),
  note: `Rare · ${title} · ${chance(picks)}`,
}));

function Thumbs({ bunnies, selected, onSelect }: { bunnies: Bunny[]; selected: string; onSelect: (bunny: Bunny) => void }) {
  const art = useMemo(() => bunnies.map((bunny) => badgeDataUri(bunny.index, bunny.hash)), [bunnies]);
  return (
    <ul className={styles.grid}>
      {bunnies.map((bunny, i) => (
        <li key={bunny.key}>
          <button
            className={styles.thumb}
            aria-pressed={bunny.key === selected}
            aria-label={`Show contribution #${bunny.index}${bunny.by ? ` by ${bunny.by}` : ""}${bunny.note ? `, ${bunny.note}` : ""}`}
            onClick={() => onSelect(bunny)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- generated SVG data URI */}
            <img src={art[i]} width="640" height="640" alt="" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Walkthrough gallery of the collectible: real rehearsal bunnies, examples and trait odds. */
export function CollectibleGallery() {
  const [rehearsal, setRehearsal] = useState<Bunny[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const sample = useMemo(() => examples(round), [round]);
  const [selected, setSelected] = useState<Bunny | null>(null);
  useEffect(() => {
    let cancelled = false;
    getRehearsalHistory()
      .then((items) => Promise.all(items.reverse().map(async ({ receipt, envelope }) => ({
        key: `rehearsal-${receipt.generation}`,
        index: receipt.contributionIndex,
        hash: await collectibleReceiptHash(envelope),
        by: receipt.participantPseudonym,
      }))))
      .then((bunnies) => { if (!cancelled) setRehearsal(bunnies); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);
  const shown = selected ?? rehearsal?.[0] ?? sample[0];
  const feature = useRef<HTMLElement>(null);
  // On narrow screens the featured card sits above the thumbnails, out of view.
  const select = (bunny: Bunny) => {
    setSelected(bunny);
    const node = feature.current;
    if (node && node.getBoundingClientRect().top < 0) {
      node.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  };

  return (
    <div className={styles.gallery}>
      <header className={styles.intro}>
        <h1>Contributor bunnies</h1>
        <p>
          Each accepted contribution can mint one bunny on MegaETH. The contract
          draws it from a hash of the signed receipt, so the same receipt always
          makes the same bunny and no two receipts match.
        </p>
      </header>

      <section ref={feature} className={styles.feature} aria-label="Selected bunny">
        <div className={card.card} key={shown.key}>
          <BadgeArt index={shown.index} receiptHash={shown.hash} />
        </div>
        <div className={styles.featureCopy}>
          <p className={styles.eyebrow}>{shown.note ?? (shown.by ? `Rehearsal · ${shown.by}` : "Example")}</p>
          <h2 aria-live="polite">Contribution #{shown.index}</h2>
          <p className={styles.hash}>
            Receipt hash <code>{shortReceipt(shown.hash)}</code>
          </p>
          <BadgeTraits receiptHash={shown.hash} />
        </div>
      </section>

      <section className={styles.set} aria-labelledby="gallery-rehearsal">
        <div className={styles.setHead}>
          <h2 id="gallery-rehearsal">From the rehearsal</h2>
          <p>The seven contributions accepted in the October rehearsal, drawn from their signed receipts.</p>
        </div>
        {rehearsal ? (
          <Thumbs bunnies={rehearsal} selected={shown.key} onSelect={select} />
        ) : (
          <p role="status">{failed ? "Could not check the rehearsal receipts." : "Checking rehearsal receipts…"}</p>
        )}
      </section>

      <section className={styles.set} aria-labelledby="gallery-rare">
        <div className={styles.setHead}>
          <h2 id="gallery-rare">Rare variants</h2>
          <p>Hashes picked to land on the rarer traits. Each card shows its odds when selected.</p>
        </div>
        <Thumbs bunnies={RARE_BUNNIES} selected={shown.key} onSelect={select} />
      </section>

      <section className={styles.set} aria-labelledby="gallery-examples">
        <div className={styles.setHead}>
          <h2 id="gallery-examples">Examples</h2>
          <p>Made-up receipt hashes, to show the range.</p>
          <button className={styles.shuffle} onClick={() => { setRound(round + 1); setSelected(null); }}>
            Shuffle examples
          </button>
        </div>
        <Thumbs bunnies={sample} selected={shown.key} onSelect={select} />
      </section>

      <section className={styles.set} aria-labelledby="gallery-odds">
        <div className={styles.setHead}>
          <h2 id="gallery-odds">Trait odds</h2>
          <p>Ten bytes of the receipt hash pick ten traits, one byte each.</p>
        </div>
        <div className={styles.odds}>
          {Object.values(TRAITS).map((trait) => (
            <div key={trait.label}>
              <h3>{trait.label}</h3>
              <ul>
                {trait.names.map((name, i) => (
                  <li key={name}><span>{name}</span><span>{odds(trait.weights[i])}</span></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
