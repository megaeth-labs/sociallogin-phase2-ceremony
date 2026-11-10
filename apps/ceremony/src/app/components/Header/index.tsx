"use client";

import type { CeremonyStep } from "@/lib/ceremony-config";
import { AccountMenu } from "../AccountMenu";
import styles from "./Header.module.css";

export function Header({
  onLogoClick,
  account = true,
}: {
  step: CeremonyStep;
  onLogoClick?: () => void;
  /** Whether to offer GitHub sign-in; an archived ceremony has nothing to sign in for. */
  account?: boolean;
}) {
  return (
    <header className={styles.header}>
      <button onClick={onLogoClick} className={styles.logoButton} aria-label="MOSS ceremony home">
        <img src="/brand/moss.svg" width="108" height="26" alt="MOSS" />
        <span className={styles.logoDivider} aria-hidden="true" />
        <span className={styles.title}>Social login ceremony <span>PHASE 02</span></span>
      </button>

      {account && <AccountMenu />}
    </header>
  );
}
