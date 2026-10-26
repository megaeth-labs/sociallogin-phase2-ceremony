import type { ReactNode } from "react";
import { AmbientVideo } from "@/app/components/AmbientVideo";
import styles from "./journey.module.css";

/**
 * Header window for the contribution journey, readiness and receipt screens:
 * the lobby hero's graded footage under a legibility wash, with a small
 * kicker and the stage title in the hero's bold caps.
 */
export function JourneyWindow({
  kicker,
  children,
  footer,
}: {
  kicker?: ReactNode;
  /** Heading block; callers own its live-region semantics. */
  children: ReactNode;
  /** Optional row pinned to the bottom of the window (e.g. the step rail). */
  footer?: ReactNode;
}) {
  return (
    <header className={styles.window}>
      <AmbientVideo className={styles.windowBg} src="/brand/hero-bg" poster="/brand/hero-bg-poster.webp" />
      {kicker && <p className={styles.kicker}>{kicker}</p>}
      {children}
      {footer}
    </header>
  );
}
