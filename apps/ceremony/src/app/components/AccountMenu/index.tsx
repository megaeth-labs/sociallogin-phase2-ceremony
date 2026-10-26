"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import styles from "./style.module.css";

/** Identity stays visible in the header; authentication is independent of queue state. */
export function AccountMenu({ previewName, onPreviewSignIn }: { previewName?: string; onPreviewSignIn?: () => void } = {}) {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = previewName || session?.participantName || session?.user?.name || "GitHub account";

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function logout() {
    if (previewName) { setOpen(false); return; }
    setBusy(true);
    setError(false);
    try {
      await signOut({ redirect: false });
      setOpen(false);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  if (onPreviewSignIn) return <button className={styles.signIn} onClick={onPreviewSignIn}>Sign in with GitHub</button>;
  if (!previewName && status === "loading") return <span className={styles.loading} role="status">Checking sign-in…</span>;
  if (!previewName && !session) return <button className={styles.signIn} onClick={() => void signIn("github")}>Sign in with GitHub</button>;

  return (
    <div className={styles.account} ref={root}>
      <button className={styles.trigger} ref={trigger} aria-expanded={open}
        aria-controls="account-panel" aria-label={`Account: @${name}`}
        onClick={() => setOpen(!open)}>
        <span className={styles.avatar} aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
        <span className={styles.identity}><span className={styles.label}>Signed in with GitHub</span><strong title={`@${name}`}>@{name}</strong></span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && <div id="account-panel" className={styles.panel}>
        <p className={styles.panelLabel}>GitHub account</p>
        <p className={styles.name}>@{name}</p>
        <button className={styles.signOut} onClick={() => void logout()} disabled={busy}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 5H5v14h4m6-11 4 4-4 4m-6-4h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {busy ? "Signing out…" : "Sign out"}
        </button>
        {error && <p className={styles.error} role="alert">Could not sign out. Please try again.</p>}
      </div>}
    </div>
  );
}
