import {
  finalBeacon,
  isRehearsalFinalization,
  PRODUCTION_FINALIZATION_DOWNLOAD,
  type CeremonyFinalization,
  type ProductionFinalization,
  type RehearsalFinalization,
} from "@/lib/finalization";
import styles from "./style.module.css";

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const size = (bytes: number) => bytes >= 1_000_000 ? megabytes(bytes) : bytes >= 1_000 ? `${(bytes / 1_000).toFixed(1)} KB` : `${bytes} bytes`;
const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;

/** Final artifacts. `rehearsal` adds the dress-rehearsal labels and warning. */
export function FinalizedCeremony({ result, rehearsal }: { result: CeremonyFinalization; rehearsal?: boolean }) {
  return isRehearsalFinalization(result)
    ? <RehearsalArtifacts result={result} rehearsal={rehearsal ?? true} />
    : <ProductionArtifacts result={result} />;
}

function Completed({ at }: { at: string }) {
  return (
    <p className={styles.date}>Verified on <time dateTime={at}>{new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</time></p>
  );
}

function ProductionArtifacts({ result }: { result: ProductionFinalization }) {
  const { artifacts, audit, proofTests } = result;
  const beacon = finalBeacon(result);
  const hashes: [string, { sha256: string; byteLength: number }][] = [
    ["Final zkey", artifacts.finalZkey],
    ["Verification key", artifacts.verificationKey],
    ["Solidity verifier", artifacts.solidityVerifier],
    ...(artifacts.sealedImport ? [["Sealed chain imported into the genesis zkey", artifacts.sealedImport] as [string, typeof artifacts.sealedImport]] : []),
    ["Beacon evidence", artifacts.beaconEvidence],
    ["Finalizer summary", artifacts.finalizerSummary],
    ["Ceremony audit", artifacts.auditReport],
    ["Proof test results", artifacts.proofEvidence],
    ["Artifact index", artifacts.artifactIndex],
  ];
  return (
    <section id="final-artifacts" className={styles.section} aria-labelledby="final-artifacts-title">
      <div className={styles.plate}>
      <div className={styles.heading}>
        <div>
          <h2 id="final-artifacts-title">Final keys and verification records</h2>
          <p>{plural(result.ordinaryContributions, "accepted contribution")}, then one public beacon from {beacon.unit.toLowerCase()} {count(beacon.value)}. Every contribution was replayed and checked before the beacon was applied, and the final key was tested with fresh proofs.</p>
        </div>
        <Completed at={result.completedAt} />
      </div>
      <div className={styles.downloads}>
        <div className={styles.primary}>
          <h3>Final proving key</h3>
          <p>The ceremony’s final zkey, including the beacon contribution.</p>
          <a className={styles.download} href={artifacts.finalZkey.url}>Download final zkey <span aria-hidden="true" /></a>
          <p className={styles.meta}>{megabytes(artifacts.finalZkey.byteLength)}</p>
        </div>
        <div className={styles.files}>
          <a href={artifacts.verificationKey.url}><span>Verification key<small>Verify proofs against the final key · JSON</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.solidityVerifier.url}><span>Solidity verifier<small>Exported contract · Tested in a local EVM</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.auditReport.url}><span>Ceremony audit<small>{plural(audit.transitionsReplayed, "contribution")} replayed · {plural(audit.receiptsChecked, "receipt")} checked</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.proofEvidence.url}><span>Proof test results<small>{plural(proofTests.validProofs, "fresh proof")} from {plural(proofTests.fixtures, "fixture")} · {plural(proofTests.solidityTests, "Solidity test")}</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.artifactIndex.url}><span>Artifact index<small>Version-pinned downloads and SHA-256 hashes</small></span><span aria-hidden>↗</span></a>
        </div>
      </div>
      <details className={styles.details}>
        <summary>Check the final key and completion record</summary>
        <dl>
          <div><dt>{beacon.label}</dt><dd>{beacon.unit} {count(beacon.value)} · {result.beaconContributions} beacon contribution · 2<sup>{result.beacon.numIterationsExp}</sup> hash iterations</dd></div>
          {"blockHash" in result.beacon
            ? <div><dt>Beacon block hash</dt><dd><code>0x{result.beacon.blockHash}</code></dd></div>
            : <div><dt>Beacon randomness</dt><dd><code>{result.beacon.randomness}</code></dd></div>}
          <div><dt>Sealed chain</dt><dd>{plural(result.sealedCheckpoint.generation, "contribution")} · head <code>{result.sealedCheckpoint.headSha256}</code></dd></div>
        </dl>
        <dl>
          {hashes.map(([label, artifact]) => (
            <div key={label}><dt>{label} · {size(artifact.byteLength)}</dt><dd><code>{artifact.sha256}</code></dd></div>
          ))}
        </dl>
        <p>
          Compare each downloaded file’s SHA-256 with the values above. The beacon evidence, the
          sealed-chain import and the finalizer summary are listed in the{" "}
          <a href={artifacts.artifactIndex.url}>artifact index</a>. The ceremony organizer signed the completion record
          with the manifest-root key. This page checks that signature and its match to the sealed contribution chain;
          it does not rerun the cryptographic verification in your browser.
        </p>
        <a href={PRODUCTION_FINALIZATION_DOWNLOAD}>Download signed completion record ↗</a>
        <p>The coordinator’s contribution checkpoint remains sealed. The signed offline completion record reports the finalization results separately.</p>
      </details>
      </div>
    </section>
  );
}

function RehearsalArtifacts({ result, rehearsal }: { result: RehearsalFinalization; rehearsal: boolean }) {
  const { artifacts } = result;
  return (
    <section id="final-artifacts" className={styles.section} aria-labelledby="final-artifacts-title">
      <div className={styles.plate}>
      <div className={styles.heading}>
        <div>
          {rehearsal && <p className={styles.eyebrow}>Rehearsal complete</p>}
          <h2 id="final-artifacts-title">Final keys and verification records</h2>
          <p>{result.ordinaryContributions} accepted contributions. One final public beacon. The final key has been verified and tested with fresh proofs.</p>
        </div>
        <Completed at={result.completedAt} />
      </div>
      <div className={styles.downloads}>
        <div className={styles.primary}>
          <h3>Final proving key</h3>
          <p>The ceremony’s final zkey, including the beacon contribution.</p>
          <a className={styles.download} href={artifacts.finalZkey.url}>Download final zkey <span aria-hidden="true" /></a>
          <p className={styles.meta}>{megabytes(artifacts.finalZkey.byteLength)}{rehearsal ? " · Rehearsal only" : ""}</p>
        </div>
        <div className={styles.files}>
          <a href={artifacts.verificationKey.url}><span>Verification key<small>Verify proofs against the final key · JSON</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.solidityVerifier.url}><span>Solidity verifier<small>Exported contract · Tested locally</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.artifactIndex.url}><span>Artifact index & ceremony evidence<small>Version-pinned downloads and SHA-256 hashes</small></span><span aria-hidden>↗</span></a>
          <a href={artifacts.proofEvidence.url}><span>Proof test results<small>Two fresh proofs from one synthetic fixture</small></span><span aria-hidden>↗</span></a>
        </div>
      </div>
      {rehearsal && <p className={styles.note}>This was a dress rehearsal. These keys are for testing and must not be used in production.</p>}
      <details className={styles.details}>
        <summary>Check the final key and completion record</summary>
        <dl>
          <div><dt>Final zkey SHA-256</dt><dd><code>{artifacts.finalZkey.sha256}</code></dd></div>
          <div><dt>Ethereum beacon block</dt><dd>{result.beacon.blockNumber.toLocaleString("en-US")} · {result.beaconContributions} beacon contribution</dd></div>
          <div><dt>Beacon block hash</dt><dd><code>0x{result.beacon.blockHash}</code></dd></div>
        </dl>
        <p>Compare the downloaded file’s SHA-256 with the value above and the artifact index. The ceremony organizer signed the completion record with the manifest-root key. This page checks that signature and its match to the sealed contribution chain; it does not rerun the cryptographic verification in your browser.</p>
        <a href="/ceremony-finalization.json">Download signed completion record ↗</a>
        <p>The coordinator’s contribution checkpoint remains sealed. The signed offline completion record reports the finalization results separately.</p>
      </details>
      </div>
    </section>
  );
}
