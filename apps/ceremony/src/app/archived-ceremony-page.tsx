"use client";

import { useEffect, useState } from "react";

import { Header } from "./components/Header";
import { ContributionHistory } from "./components/ContributionHistory";
import { DownloadFinalButton, PublicLobby } from "./components/PublicCeremony";
import { VerifyScreen } from "./screens/VerifyScreen";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import styles from "./page.module.css";

/**
 * The homepage once the ceremony is archived: the completed ceremony, its
 * history and the way to verify it, from the signed records bundled with the
 * site. Nothing here signs anyone in or asks the retired coordinator anything.
 */
export default function ArchivedCeremonyPage() {
  const [step, setStep] = useState<"landing" | "verify">("landing");
  const { status, statusError } = useCeremonyStatus({ poll: false });

  // The verify guide sends people back to the history table, which exists
  // once the homepage has rendered.
  const [historyPending, setHistoryPending] = useState(false);
  useEffect(() => {
    if (!historyPending || step !== "landing") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const table = document.getElementById("history");
      if (table || Date.now() - started > 5000) {
        window.clearInterval(timer);
        table?.scrollIntoView({ block: "start" });
        setHistoryPending(false);
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [historyPending, step]);

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <Header step={step} account={false} onLogoClick={() => setStep("landing")} />
        <main className={`${styles.main} ${(step === "landing" && status) || step === "verify" ? styles.landing : ""}`}>
          {step === "landing" && !status && !statusError && (
            <div className={styles.loader}>
              <div className={styles.spinner} />
              <p className={styles.loaderText}>Loading ceremony...</p>
            </div>
          )}
          {step === "landing" && status && (
            <PublicLobby
              status={status}
              participation={status.finalization ? <DownloadFinalButton /> : null}
              history={<ContributionHistory />}
              onVerify={() => setStep("verify")}
            />
          )}
          {step === "verify" && (
            <VerifyScreen onBack={() => { setStep("landing"); setHistoryPending(true); }} />
          )}
          {statusError && (
            <div className={styles.statusError} role="alert">
              <h2>Ceremony records unavailable</h2>
              <p>{statusError}</p>
              <p>Reload the page to try again.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
