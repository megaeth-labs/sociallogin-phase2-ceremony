"use client";

import { useEffect, useState } from "react";
import { Button } from "@/app/components/Button";
import { HISTORY_PAGE_SIZE, type VerifiedPublicReceipt } from "@/lib/api";
import { useContributionHistory } from "./source";
import styles from "./style.module.css";

export function ReceiptDetails({ item }: { item: VerifiedPublicReceipt }) {
  const { receipt, envelope } = item;
  const bellman = item.policy.verificationMethod === "bellman-transition-v1";
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `receipt-${receipt.ceremonyId}-${receipt.contributionIndex}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <div className={styles.details}>
      <dl>
        <dt>Participant</dt><dd>{receipt.participantPseudonym}</dd>
        <dt>Accepted</dt><dd><time dateTime={receipt.acceptedAt}>{new Date(receipt.acceptedAt).toLocaleString()}</time></dd>
        <dt>Client</dt><dd>{receipt.clientKind}</dd>
        <dt>Contribution name</dt><dd>{receipt.contributionName}</dd>
        <dt>Output SHA-256</dt><dd><code>{receipt.successor.sha256}</code></dd>
        <dt>Output size</dt><dd>{receipt.successor.byteLength.toLocaleString()} bytes</dd>
        <dt>Predecessor SHA-256</dt><dd><code>{receipt.predecessor.sha256}</code></dd>
        <dt>Contribution BLAKE2b-512</dt><dd><code>{receipt.contributionHashBlake2b512}</code></dd>
        <dt>Transcript event hash</dt><dd><code>{receipt.transcriptEventHash}</code></dd>
        <dt>Receipt signing key</dt><dd>{envelope.keyId}</dd>
      </dl>
      <h3>Server acceptance checks</h3>
      <ul>
        <li>Upload SHA-256 and byte length checked against the submitted bytes.</li>
        <li>Exact predecessor preserved, with exactly one new contribution.</li>
        <li>{bellman ? "Checked Bellman proof-of-knowledge and parameter-transition verification against the exact accepted predecessor." : "Full snarkjs verification against the pinned genesis and PTAU."}</li>
        <li>Signed verifier reports checked before transactional head acceptance.</li>
      </ul>
      <div className={styles.actions}>
        <button className={styles.download} onClick={download}>Download signed receipt</button>
        {item.artifactDownloadUrl && <a className={styles.download} href={item.artifactDownloadUrl} download={`contribution-${receipt.contributionIndex}.${bellman ? "params" : "zkey"}`}>Download contribution {bellman ? "parameters" : "zkey"}</a>}
      </div>
    </div>
  );
}

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function shortHash(hex: string) {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

export function ContributionHistory() {
  const [requestedPage, setPage] = useState(0);
  const { data, error, isPending, isPlaceholderData } = useContributionHistory(requestedPage);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  const start = page * HISTORY_PAGE_SIZE;
  const visible = data?.items;
  return (
    <section className={styles.history} aria-labelledby="history-heading">
      <div className={styles.head}>
        <div>
          <h2 id="history-heading">Contribution history</h2>
          <p>Accepted contributions, newest first.</p>
        </div>
        {!error && data && (
          <p className={styles.total}>
            <span className={styles.totalNumber}>{total.toLocaleString()}</span>
            <span>accepted {total === 1 ? "contribution" : "contributions"} in total</span>
          </p>
        )}
      </div>
      {isPending && <p role="status">Loading contribution history…</p>}
      {error && <p role="alert">Could not verify the latest history: {error.message}</p>}
      {!error && total === 0 && data && <p>No accepted contributions yet. Entries appear after verification and acceptance.</p>}
      {!error && total > 0 && (
        <div className={styles.ledger} aria-busy={isPlaceholderData}>
          <div className={styles.columns} aria-hidden="true">
            <span>Contributor</span>
            <span className={styles.colOutput}>Output</span>
            <span>Accepted</span>
            <span>Status</span>
            <span />
          </div>
          {visible?.map((item) => (
            <details className={styles.entry} key={item.receipt.generation}>
              <summary>
                <span className={styles.who}>
                  <span className={styles.index}>#{item.receipt.contributionIndex}</span>
                  <span className={styles.name}>{item.receipt.participantPseudonym}</span>
                </span>
                <code className={styles.output} title={item.receipt.successor.sha256}>{shortHash(item.receipt.successor.sha256)}</code>
                <time className={styles.timestamp} dateTime={item.receipt.acceptedAt} title={new Date(item.receipt.acceptedAt).toLocaleString()}>
                  {shortDate.format(new Date(item.receipt.acceptedAt))}
                </time>
                <span className={styles.badge}>
                  <span className={styles.visuallyHidden}>Accepted, receipt signature verified</span>
                  <span aria-hidden="true">Signed</span>
                </span>
              </summary>
              <ReceiptDetails item={item} />
            </details>
          ))}
          <nav className={styles.pagination} aria-label="Contribution history pages">
            <Button variant="secondary" size="small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <p role="status" aria-live="polite">
              {isPlaceholderData ? "Loading page…" : <>Page {page + 1} of {pageCount.toLocaleString()} · Showing {(start + 1).toLocaleString()}–{Math.min(start + HISTORY_PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}</>}
            </p>
            <Button variant="secondary" size="small" disabled={page === pageCount - 1} onClick={() => setPage(page + 1)}>Next</Button>
          </nav>
        </div>
      )}
    </section>
  );
}
