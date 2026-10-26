"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { keccak256, toHex } from "viem";
import { useContributionHistory } from "@/app/components/ContributionHistory/source";
import { badgeDataUri } from "@/lib/nft/badge-svg";
import { CYBER_EYE_EXAMPLE, forcedHash } from "@/lib/nft/forced-traits";
import { EntropyBunny } from "@/app/screens/EntropyScreen/EntropyBunny";
import styles from "./lobby.module.css";
import { WALKTHROUGH_STEPS } from "@/lib/walkthrough-steps";

/**
 * Generator output for made-up receipts, shown as examples of the collectible.
 * Seeds are picked so the three cards differ in glass, background, ears, outfit
 * and accessories: pale gold one-lop in shades and a data jack on blue paper,
 * lilac glass with a visor on neon bloom, and the gallery's rare #77 with a
 * cyber eye.
 */
const EXAMPLE_BUNNIES = [
  badgeDataUri(42, keccak256(toHex("showcase-119"))),
  badgeDataUri(128, keccak256(toHex("showcase-51"))),
  badgeDataUri(CYBER_EYE_EXAMPLE.index, forcedHash(CYBER_EYE_EXAMPLE.seed, CYBER_EYE_EXAMPLE.picks)),
];

/**
 * A pocket version of the entropy screen: the same bunny on a small circuit
 * floor. It chases the pointer and jumps on clicks; left alone it wanders
 * between random spots, shedding bits, while a corner meter fills and loops.
 */
function RandomnessField() {
  const field = useRef<HTMLDivElement>(null);
  const meter = useRef<HTMLSpanElement>(null);
  const filled = useRef(0);
  const onLand = useCallback(() => {
    filled.current = filled.current >= 1 ? 0 : Math.min(1, filled.current + 0.125);
    if (meter.current) meter.current.style.transform = `scaleX(${filled.current})`;
  }, []);
  return (
    <div ref={field} className={styles.field} aria-hidden="true">
      <EntropyBunny areaRef={field} scale={0.4} travel={0.45} autonomous onLand={onLand} />
      <span className={styles.fieldMeter}>
        <span ref={meter} />
      </span>
    </div>
  );
}

/** The ceremony's defining properties, each shown with live evidence where it exists. */
export function LobbyTraits({
  open,
  closed,
  finalized,
  collectiblesEnabled,
  bandOnly = false,
}: {
  open: boolean;
  /** Contributions have closed; there is no next slot to show. */
  closed: boolean;
  finalized: boolean;
  collectiblesEnabled: boolean;
  /** A finished ceremony shows its artifacts instead, keeping only the band. */
  bandOnly?: boolean;
}) {
  // Shares the history card's query, so this adds no extra request.
  const { data, isError } = useContributionHistory();
  const recent = (data?.items ?? []).slice(0, 4).reverse();
  // Ambient motion only runs while the grid is on screen.
  const bento = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const node = bento.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setLive(entry.isIntersecting), { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const howItWorks = <>
    <span className={styles.howText}>
      <strong>See how the ceremony works, step by step.</strong>
      <span>From joining the queue to the final published key, and all the checks along the way.</span>
    </span>
    <svg className={styles.howRail} viewBox="0 0 300 40" aria-hidden="true">
      <path d="M10 20H290" />
      {Array.from({ length: 10 }, (_, i) => (
        <rect key={i} x={6 + i * 31} y="16" width="8" height="8" rx="2" data-end={i === 9} />
      ))}
      <rect className={styles.howPacket} x="8" y="18" width="4" height="4" rx="1" />
    </svg>
    <span className={styles.howArrow} aria-hidden="true" />
  </>;
  return (
    <section className={styles.traits} aria-labelledby={bandOnly ? undefined : "traits-title"} aria-label={bandOnly ? "How the ceremony works" : undefined}>
      {!bandOnly && <>
      <h2 id="traits-title" className={styles.traitsTitle}>
        How the ceremony keeps social login secure
      </h2>
      <div ref={bento} className={styles.bento} data-live={live}>
        <article className={`${styles.tray} ${styles.chainTile}`}>
          <div className={`${styles.plate} ${styles.night}`}>
            <h3>Each contribution builds on the last</h3>
            <p>
              Your browser adds fresh randomness. The next participant starts
              from your result.
            </p>
            <ol className={styles.chain} aria-label="Most recent accepted contributions">
              {isError ? (
                <li className={styles.chainNote}>Couldn’t load recent contributions. Retrying.</li>
              ) : recent.length === 0
                ? [0, 1, 2].map((i) => (
                    <li key={i} className={styles.chainGhost} aria-hidden="true" style={{ "--i": i } as CSSProperties}>
                      <span className={styles.chainPulse} />
                      <span className={styles.ghostBar} />
                      <span className={styles.ghostBar} />
                    </li>
                  ))
                : recent.map(({ receipt }, i) => (
                    <li key={receipt.generation} style={{ "--i": i } as CSSProperties}>
                      <span className={styles.chainPulse} aria-hidden="true" />
                      <span className={styles.chainIndex}>#{receipt.contributionIndex}</span>
                      <span className={styles.chainName}>{receipt.participantPseudonym}</span>
                    </li>
                  ))}
              {!closed && (
                <li className={styles.chainNext} data-open={open} style={{ "--i": Math.max(recent.length, isError ? 1 : 3) } as CSSProperties}>
                  <span className={styles.chainPulse} aria-hidden="true" />
                  <span className={styles.chainIndex}>{open ? "Next" : "Waiting"}</span>
                  <span className={styles.chainName}>{open ? "Your contribution" : "Opens soon"}</span>
                </li>
              )}
            </ol>
          </div>
        </article>

        <article className={`${styles.tray} ${styles.honestTile}`}>
          <div className={styles.plate}>
            {/* Five contributors' secrets. The others leak one by one; the
                honest one stays locked, and that alone keeps the keys safe. */}
            <svg className={styles.honestGlyph} viewBox="0 0 248 84" aria-hidden="true">
              <path className={styles.lockLine} d="M8 62H240" />
              {[0, 1, 2, 3, 4].map((i) => {
                const x = 28 + i * 48;
                const honest = i === 2;
                const order = [0, 1, 0, 2, 3][i];
                return (
                  <g
                    key={i}
                    className={honest ? styles.lockHonest : styles.lockLeak}
                    style={honest ? undefined : ({ "--i": order } as CSSProperties)}
                  >
                    {honest && <rect className={styles.lockHalo} x={x - 22} y={22} width="44" height="54" rx="14" />}
                    <path className={styles.shackle} d={`M${x - 8} 46v-10a8 8 0 0 1 16 0v10`} />
                    <rect className={styles.lockBody} x={x - 14} y={44} width="28" height="24" rx="6" />
                    <circle className={styles.keyhole} cx={x} cy={55} r="2.5" />
                  </g>
                );
              })}
            </svg>
            <h3>One honest contribution is enough</h3>
            <p>
              The keys stay secure as long as at least one participant’s
              randomness stays secret. The same applies to the public
              Powers of Tau ceremony this builds on.
            </p>
          </div>
        </article>

        <article className={`${styles.tray} ${styles.localTile}`}>
          <div className={styles.plate}>
            <RandomnessField />
            <h3>Randomness made in your browser</h3>
            <p>
              Your pointer movements are mixed with your browser’s own
              randomness, and the contribution is computed on your device. The
              secret never leaves it.
            </p>
          </div>
        </article>

        {collectiblesEnabled ? (
          <article className={`${styles.tray} ${styles.keepTile}`}>
            <div className={`${styles.plate} ${styles.night}`}>
              <div className={styles.keepFan} aria-hidden="true">
                {EXAMPLE_BUNNIES.map((src) => (
                  // eslint-disable-next-line @next/next/no-img-element -- generated SVG data URI
                  <img key={src} src={src} width="640" height="640" alt="" />
                ))}
              </div>
              <h3>Mint a bunny</h3>
              <p>
                Accepted contributors can mint a unique bunny on MegaETH. Each
                one is generated onchain from a hash of your contribution, so no
                two are alike. It’s a keepsake; your signed receipt is still the
                record.
              </p>
            </div>
          </article>
        ) : (
          // Without the collectible, the walkthrough takes its tile: the steps
          // themselves, each linking to its section.
          <a className={`${styles.tray} ${styles.howTile}`} href="/how-it-works">
            <div className={`${styles.plate} ${styles.night}`}>
              {/* A packet walks the ten steps, each lighting up as it's
                  reached. Decorative. */}
              <div className={styles.howFlow} aria-hidden="true">
                <svg className={styles.howRail} viewBox="0 0 300 40">
                  <path d="M10 20H290" />
                  {WALKTHROUGH_STEPS.map((step, i) => (
                    <rect key={step.id} x={6 + i * 31} y="16" width="8" height="8" rx="2" data-end={i === 9} />
                  ))}
                  {WALKTHROUGH_STEPS.map((step, i) => (
                    <rect key={`lit-${step.id}`} className={styles.howLit} x={5 + i * 31} y="15" width="10" height="10" rx="2.5" style={{ "--i": i } as CSSProperties} />
                  ))}
                  <rect className={styles.howStepper} x="8" y="18" width="4" height="4" rx="1" />
                </svg>
              </div>
              <h3>See how the ceremony works, step by step.</h3>
              <p className={styles.howBody}>From joining the queue to the final published key, and all the checks along the way.</p>
              <span className={styles.howArrow} aria-hidden="true" />
            </div>
          </a>
        )}
      </div>
      </>}
      {(bandOnly || collectiblesEnabled) && (
        <a className={styles.howBand} href="/how-it-works" data-live={bandOnly || live}>{howItWorks}</a>
      )}
    </section>
  );
}
