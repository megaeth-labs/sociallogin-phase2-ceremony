import { BadgeArt } from "./BadgeArt";
import styles from "./style.module.css";

export { BadgeArt, BadgeTraits } from "./BadgeArt";

/**
 * Invitation to mint the contribution's bunny, shown as a section of the
 * completion page. A document navigation isolates the wallet iframe from
 * contribution workers.
 */
export function ContributionCollectible({
  receiptId,
  index,
  receiptHash,
  preview = false,
}: {
  preview?: boolean;
  receiptId: string;
  index: number;
  /** Shows the contributor's own bunny; without it the silhouette stands in. */
  receiptHash?: string;
}) {
  const collectHref = preview ? "/review?screen=wallet" : `/collect?receiptId=${encodeURIComponent(receiptId)}`;
  return (
      <section className={styles.keep} aria-labelledby="collectible-title">
        <div className={styles.keepPlate}>
          <div className={styles.card} data-revealed={!!receiptHash}>
            <BadgeArt index={index} receiptHash={receiptHash} />
          </div>
          <div className={styles.keepCopy}>
            <h2 id="collectible-title">Mint a bunny</h2>
            <p>
              You can mint a MOSS collectible for contribution #{index} and keep
              it in your wallet. Your bunny is generated onchain from a hash of
              your contribution receipt, so no two are alike.
            </p>
            <a className={styles.primary} href={collectHref}>
              Collect with MOSS Wallet
            </a>
            <p className={styles.note}>
              Optional, and it doesn’t affect acceptance. You can also collect
              it later from your contribution history.
            </p>
          </div>
        </div>
      </section>
    );
}
