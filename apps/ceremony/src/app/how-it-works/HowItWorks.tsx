"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { keccak256, toHex } from "viem";
import { AmbientVideo } from "@/app/components/AmbientVideo";
import { walkthroughStep } from "@/lib/walkthrough-steps";
import { Header } from "@/app/components/Header";
import { SiteFooter } from "@/app/components/SiteFooter";
import { useContributionHistory } from "@/app/components/ContributionHistory/source";
import { formatUtc } from "@/lib/countdown";
import { badgeDataUri } from "@/lib/nft/badge-svg";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import styles from "./how.module.css";

function shortHash(hex: string) {
  const clean = hex.replace(/^0x/, "");
  return `${clean.slice(0, 8)}…${clean.slice(-8)}`;
}

const EXAMPLE_BUNNY = badgeDataUri(128, keccak256(toHex("showcase-51")));

type Station = {
  id: string;
  short: string;
  title: string;
  body: ReactNode;
  art: ReactNode;
};

/* ── Illustrations ─────────────────────────────────────────────
 * Small night-moss drawings, one per station. Ambient motion is CSS-only
 * and runs while the station is on screen. */

function QueueArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <path className={styles.line} d="M196 40v80M206 40v80" />
      <g className={styles.queueShift}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={i} className={i === 0 ? styles.cellLit : styles.cell} x={150 - i * 34} y="66" width="26" height="28" rx="7" />
        ))}
      </g>
      <rect className={styles.cellLit} x="226" y="66" width="26" height="28" rx="7" />
      <text className={styles.artLabel} x="239" y="118" textAnchor="middle">your slot</text>
    </svg>
  );
}

function DownloadArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <path className={styles.file} d="M96 22h62l26 26v92H96Z" />
      <path className={styles.line} d="M158 22v26h26" />
      {[62, 76, 90, 104].map((y, i) => (
        <rect key={y} className={styles.hashLine} x="110" y={y} width={[58, 44, 52, 36][i]} height="5" rx="2.5" />
      ))}
      <g className={styles.pop}>
        <circle className={styles.badge} cx="186" cy="122" r="18" />
        <path className={styles.tick} d="M177 122l6 6 12-13" />
      </g>
    </svg>
  );
}

function EntropyArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <path className={styles.trail} d="M24 118c26-44 46-58 70-34s38 40 64 8 42-52 70-26 22 30 30 18" />
      {[[48, 92], [84, 82], [118, 106], [150, 76], [196, 64], [236, 86]].map(([x, y], i) => (
        <rect key={x} className={styles.bit} x={x - 4} y={y - 4} width="8" height="8" rx="2" style={{ animationDelay: `${i * 0.22}s` }} />
      ))}
      <path className={styles.cursor} d="M250 96l0 30 8-8 6 13 6-3-6-12 11 0Z" />
    </svg>
  );
}

function ComputeArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <rect className={styles.chip} x="70" y="24" width="140" height="112" rx="16" />
      {Array.from({ length: 24 }, (_, i) => {
        const x = 86 + (i % 6) * 19;
        const y = 40 + Math.floor(i / 6) * 22;
        return (
          <g key={i}>
            <rect className={styles.cell} x={x} y={y} width="13" height="13" rx="3" />
            <rect className={styles.flash} x={x} y={y} width="13" height="13" rx="3" style={{ animationDelay: `${((i * 37) % 13) * 0.27}s`, animationDuration: `${2 + ((i * 11) % 7) * 0.35}s` }} />
          </g>
        );
      })}
      {[44, 68, 92, 116].map((y) => (
        <path key={y} className={styles.line} d={`M52 ${y}h18M210 ${y}h18`} />
      ))}
    </svg>
  );
}

function UploadArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <rect className={styles.device} x="24" y="30" width="126" height="108" rx="14" />
      <text className={styles.artLabel} x="87" y="128" textAnchor="middle">your device</text>
      <g transform="translate(66 62)">
        <rect className={styles.lockBody} x="0" y="14" width="42" height="32" rx="7" />
        <path className={styles.lockShackle} d="M9 14V8a12 12 0 0 1 24 0v6" />
      </g>
      <g className={styles.lift}>
        <path className={styles.file} d="M196 70h34l14 14v46h-48Z" />
        <path className={styles.arrowUp} d="M220 60V30m-9 9 9-9 9 9" />
      </g>
    </svg>
  );
}

function ChainArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <g key={i}>
          {i > 0 && <path className={styles.line} d={`M${i * 88 - 10} 80h22`} />}
          <rect className={i === 2 ? styles.blockNext : styles.block} x={i * 88 + 12} y="52" width="68" height="56" rx="12" />
          <rect className={styles.hashLine} x={i * 88 + 24} y="70" width="34" height="5" rx="2.5" />
          <rect className={styles.hashLine} x={i * 88 + 24} y="84" width="22" height="5" rx="2.5" />
        </g>
      ))}
      <rect className={styles.packet} x="78" y="78" width="5" height="5" rx="1" />
      <rect className={styles.packet} x="166" y="78" width="5" height="5" rx="1" style={{ animationDelay: ".7s" }} />
    </svg>
  );
}

function SealArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} className={styles.block} x={18 + i * 50} y="60" width="40" height="40" rx="9" />
      ))}
      <path className={styles.line} d="M58 80h10M108 80h10M158 80h10" />
      <path className={styles.gate} d="M232 34v92" />
      <g transform="translate(208 62)" className={styles.pop}>
        <rect className={styles.lockBodyLit} x="12" y="14" width="34" height="26" rx="6" />
        <path className={styles.lockShackleLit} d="M19 14V9a10 10 0 0 1 20 0v5" />
      </g>
    </svg>
  );
}

function BeaconArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <path className={styles.dash} d="M140 34v116" />
      <rect className={styles.signal} x="137" y="140" width="6" height="6" rx="1.5" />
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(80 ${100 - i * 34})`}>
          <g className={i === 2 ? styles.float : undefined}>
            <path className={i === 2 ? styles.isoTopLit : styles.isoTop} d="M60 0 110 20 60 40 10 20Z" />
            <path className={i === 2 ? styles.isoSideLit : styles.isoSide} d="M10 20v10l50 20 50-20V20M60 40v10" />
          </g>
        </g>
      ))}
      <text className={styles.artLabel} x="236" y="40" textAnchor="middle">Ethereum</text>
      <text className={styles.artLabel} x="236" y="54" textAnchor="middle">block</text>
    </svg>
  );
}

function PublishArt() {
  return (
    <svg viewBox="0 0 280 160" aria-hidden="true">
      <circle className={styles.ring} cx="140" cy="80" r="34" />
      <circle className={styles.ring} cx="140" cy="80" r="34" style={{ animationDelay: "1.2s" }} />
      <g transform="translate(110 62)">
        <circle className={styles.keyBow} cx="14" cy="18" r="12" />
        <path className={styles.keyBit} d="M26 18h34v10M48 18v8" />
      </g>
    </svg>
  );
}

function CheckList() {
  // Page 0 is the lobby's query too, so visiting both pages costs one request.
  const { data, isError } = useContributionHistory();
  const latest = data?.items[0];
  const policy = latest?.policy;
  return (
    <div className={styles.checkPanel}>
      <ul className={styles.checklist} aria-label="Acceptance checks">
        {["Upload hash and size match", "Builds on the exact previous file", "Adds exactly one new contribution", "Signed verifier reports"].map((check, i) => (
          <li key={check} style={{ "--i": i } as CSSProperties}>{check}</li>
        ))}
      </ul>
      <dl className={styles.hashRow}>
        <dt>Latest accepted output</dt>
        <dd>
          {latest ? (
            <code title={latest.receipt.successor.sha256}>{shortHash(latest.receipt.successor.sha256)}</code>
          ) : isError ? "Couldn’t load the latest record. Retrying." : data ? "Appears after the first acceptance" : "Loading…"}
        </dd>
        {policy && (
          <>
            <dt>Verifier policy</dt>
            <dd>
              {policy.requiredOperators} {policy.requiredOperators === 1 ? "operator" : "operators"}, {policy.passesPerOperator} {policy.passesPerOperator === 1 ? "pass" : "passes"} each, unanimous
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The live closing time, appended to the Close step when status is known. */
function Deadline() {
  const { status } = useCeremonyStatus();
  if (!status?.endDate) return null;
  return (
    <> This ceremony closes on <time dateTime={status.endDate}>{formatUtc(status.endDate)}</time>.</>
  );
}

const stations: Station[] = [
  {
    ...walkthroughStep("join"),
    body: "Sign in with GitHub and check that your browser is ready. Only one contribution runs at a time, so you wait in a queue until it’s your turn. Signing in doesn’t claim a slot; when your turn comes, claim the offer before it expires.",
    art: <QueueArt />,
  },
  {
    ...walkthroughStep("download"),
    body: "Your browser downloads the parameters file that the last accepted contributor produced and checks it against the hash the coordinator signed. If it doesn’t match, it’s rejected before any work starts.",
    art: <DownloadArt />,
  },
  {
    ...walkthroughStep("randomness"),
    body: "Move your pointer, click or type. Those inputs are mixed with your browser’s secure random number generator to make a secret that only exists in this tab. It’s never uploaded, and the page discards it when the attempt ends.",
    art: <EntropyArt />,
  },
  {
    ...walkthroughStep("compute"),
    body: "A background worker in your browser applies your secret to the downloaded file to produce the next one. It takes about 5–10 minutes on a desktop computer, so keep the tab in the foreground and your computer awake until the upload finishes.",
    art: <ComputeArt />,
  },
  {
    ...walkthroughStep("upload"),
    body: "Only the resulting file goes up. Your private randomness is never part of the upload.",
    art: <UploadArt />,
  },
  {
    ...walkthroughStep("verify"),
    body: "Verifiers check each contribution against its predecessor, including the proof that you knew your secret and transformed the file correctly. A contribution that fails any check is never added to the chain.",
    art: <CheckList />,
  },
  {
    ...walkthroughStep("receipt"),
    body: "The coordinator signs a receipt that ties your contribution to the file it built on, its output hash and when it was accepted, and the next participant starts from your result. Keep your receipt, and check the final ceremony record later to confirm you were included.",
    art: <ChainArt />,
  },
  {
    ...walkthroughStep("close"),
    body: <>At the deadline in the signed manifest, the coordinator seals the chain and stops accepting contributions.<Deadline /></>,
    art: <SealArt />,
  },
  {
    ...walkthroughStep("beacon"),
    body: "A future Ethereum block, named in the signed manifest before contributions open, supplies one final contribution after the chain is sealed. Its hash isn’t known in advance, so no participant or organizer can choose the final result.",
    art: <BeaconArt />,
  },
  {
    ...walkthroughStep("publish"),
    body: "The organizer replays the whole chain from the first file to the sealed one, applies the beacon, verifies the final key and publishes it with its hashes. Anyone can download the published files and check them on their own computer.",
    art: <PublishArt />,
  },
];

export function HowItWorks({ collectiblesEnabled = false }: { collectiblesEnabled?: boolean }) {
  const [active, setActive] = useState(-1);
  const [seen, setSeen] = useState<Set<number>>(() => new Set());
  const [live, setLive] = useState<Set<number>>(() => new Set());
  const [animated, setAnimated] = useState(false);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    setAnimated(true);
    const nodes = refs.current.filter(Boolean) as HTMLLIElement[];
    const index = (el: Element) => Number((el as HTMLElement).dataset.index);
    // The current station is the last one whose top has passed the middle of
    // the viewport. Recomputed from positions on every observer callback, so a
    // jump (Home key, anchor link) that skips the midline can't leave it stale.
    const sync = () => {
      const middle = window.innerHeight / 2;
      let current = -1;
      nodes.forEach((node, i) => {
        if (node.getBoundingClientRect().top <= middle) current = i;
      });
      setActive(current);
    };
    const centre = new IntersectionObserver(sync, { rootMargin: "-50% 0px -50% 0px" });
    // Reveal each station once, and only animate the ones on screen.
    const visible = new IntersectionObserver((entries) => {
      setLive((prev) => {
        const next = new Set(prev);
        for (const entry of entries) {
          if (entry.isIntersecting) next.add(index(entry.target));
          else next.delete(index(entry.target));
        }
        return next;
      });
      setSeen((prev) => {
        const next = new Set(prev);
        for (const entry of entries) if (entry.isIntersecting) next.add(index(entry.target));
        return next.size === prev.size ? prev : next;
      });
      sync();
    }, { threshold: [0, 0.2] });
    nodes.forEach((node) => { centre.observe(node); visible.observe(node); });
    // Everything around the rail too, so a jump that skips every station
    // (straight to the intro or the footer) still re-syncs.
    const edges = new IntersectionObserver(sync);
    document.querySelectorAll("main > *, footer").forEach((el) => edges.observe(el));
    return () => { centre.disconnect(); visible.disconnect(); edges.disconnect(); };
  }, []);

  const progress = active < 0 ? 0 : (active + 1) / stations.length;

  return (
    <div className={styles.page} data-animated={animated}>
      <Header step="landing" onLogoClick={() => window.location.assign("/")} />
      <main className={styles.main}>
        <section className={styles.intro} aria-labelledby="how-title">
          <AmbientVideo className={styles.introBg} src="/brand/hero-bg" poster="/brand/hero-bg-poster.webp" />
          <div className={styles.introInner}>
            <h1 id="how-title">How the ceremony works</h1>
            <p className={styles.lede}>
              Every step from joining the queue to the published key, and what gets checked along the way.
            </p>
            <nav aria-label="Ceremony steps">
              <ol className={styles.overview}>
                {stations.map((station, i) => (
                  <li key={station.id} data-active={i === active} data-done={i < active}>
                    <a href={`#${station.id}`}>
                      <span className={styles.node} aria-hidden="true" />
                      <span className={styles.overviewNumber}>{i + 1}</span>
                      <span>{station.short}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </div>
        </section>

        <section className={styles.why} aria-labelledby="why-title">
          <div className={styles.whyText}>
            <h2 id="why-title">Why a ceremony?</h2>
            <p>
              MOSS’s social login uses zero-knowledge proofs. Those proofs are checked against public
              parameters, and whoever creates the parameters also learns a secret that could be used
              to forge proofs.
            </p>
            <p>
              A ceremony splits that secret across many people. Each contributor mixes in their own
              randomness and then discards it. As long as at least one contributor’s randomness was
              never revealed, nobody can rebuild the secret.
            </p>
          </div>
          <div className={styles.whyArt} aria-hidden="true">
            <svg viewBox="0 0 320 260">
              {Array.from({ length: 6 }, (_, i) => (
                <g key={i} transform={`translate(0 ${190 - i * 30})`}>
                  <path className={i === 3 ? styles.layerLit : styles.layer} d="M160 0 290 46 160 92 30 46Z" style={{ animationDelay: `${i * 0.35}s` }} />
                </g>
              ))}
            </svg>
            <p>Each layer is one contribution. One honest layer is enough.</p>
          </div>
        </section>

        <section className={styles.stationsSection} aria-labelledby="steps-title">
          <h2 id="steps-title" className={styles.stepsTitle}>Step by step</h2>
          <div className={styles.stationsWrap}>
          <div className={styles.rail} aria-hidden="true">
            <span className={styles.railFill} style={{ transform: `scaleY(${progress})` }} />
          </div>
          <ol className={styles.stations}>
            {stations.map((station, i) => (
              <li
                key={station.id}
                id={station.id}
                ref={(el) => { refs.current[i] = el; }}
                data-index={i}
                data-seen={seen.has(i)}
                data-live={live.has(i)}
                data-active={i === active}
                className={styles.station}
              >
                <span className={styles.stationNumber} aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                <div className={styles.stationText}>
                  <h3><span className={styles.visuallyHidden}>Step {i + 1}: </span>{station.title}</h3>
                  <p>{station.body}</p>
                </div>
                <div className={styles.stationArt}>{station.art}</div>
              </li>
            ))}
          </ol>
          </div>
        </section>

        {collectiblesEnabled && (
          <section className={styles.aside} aria-labelledby="bunny-title">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated SVG data URI */}
            <img src={EXAMPLE_BUNNY} width="640" height="640" alt="" />
            <div>
              <h2 id="bunny-title">Mint a bunny</h2>
              <p>
                Accepted contributors can mint a unique bunny on MegaETH. Each one
                is generated onchain from a hash of the contributor’s receipt, so
                no two are alike.{" "}
                It doesn’t affect acceptance; your signed receipt is still the record.
              </p>
            </div>
          </section>
        )}

        <section className={styles.cta} aria-labelledby="cta-title">
          <h2 id="cta-title">Ready to add yours?</h2>
          <div className={styles.ctaActions}>
            <a className={styles.ctaPrimary} href="/">Go to the ceremony</a>
            <a className={styles.ctaSecondary} href="/#verify">Verify a contribution</a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
