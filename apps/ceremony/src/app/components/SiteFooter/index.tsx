import styles from "./style.module.css";

/**
 * Footer shared by the lobby and the how-it-works page. On the lobby the
 * ceremony links are in-page anchors and "Verify locally" opens the guide
 * directly; elsewhere they point back at the lobby's sections.
 */
export function SiteFooter({
  onVerify,
  finalized = false,
  home = false,
}: {
  onVerify?: () => void;
  finalized?: boolean;
  /** Rendered on the lobby itself, so section links stay in-page. */
  home?: boolean;
}) {
  const lobby = home ? "" : "/";
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <img src="/brand/moss.svg" width="166" height="40" alt="MOSS" />
          <p>Phase 2 of the trusted setup behind MOSS’s ZK-powered social login.</p>
        </div>
        <nav className={styles.footerLinks} aria-label="Footer">
          <div>
            <h2>Ceremony</h2>
            <ul>
              <li><a href="/how-it-works">How it works</a></li>
              <li><a href={`${lobby}#history`}>Contribution history</a></li>
              {finalized && <li><a href={`${lobby}#final-artifacts`}>Final artifacts</a></li>}
              <li>
                {onVerify ? (
                  <button type="button" onClick={onVerify}>Verify locally</button>
                ) : (
                  <a href={`${lobby}#verify`}>Verify locally</a>
                )}
              </li>
            </ul>
          </div>
          <div>
            <h2>MOSS</h2>
            <ul>
              <li><a href="https://joinmoss.megaeth.com" target="_blank" rel="noopener noreferrer">MOSS Wallet</a></li>
              <li><a href="https://account.megaeth.com" target="_blank" rel="noopener noreferrer">Your MOSS account</a></li>
            </ul>
          </div>
          <div>
            <h2>MegaETH</h2>
            <ul>
              <li><a href="https://megaeth.com" target="_blank" rel="noopener noreferrer">MegaETH</a></li>
              <li><a href="https://docs.megaeth.com" target="_blank" rel="noopener noreferrer">Documentation</a></li>
            </ul>
          </div>
        </nav>
        <div className={styles.footerBase}>
          <span>MOSS social login ceremony</span>
          <span className={styles.footerMega}>
            <img src="/brand/mega.svg" width="20" height="20" alt="" />
            Built on MegaETH
          </span>
        </div>
      </div>
    </footer>
  );
}
