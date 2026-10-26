"use client";

import { useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildRepositorySetup, CLIENT_BUILD, SIGNING_KEY_FILE } from "@/lib/cli-instructions";
import { getVerificationGuide } from "@/lib/api";
import { Button } from "@/app/components/Button";
import { AmbientVideo } from "@/app/components/AmbientVideo";
import { VerificationGuideSource } from "./source";
import styles from "./VerifyScreen.module.css";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function VerifyScreen({ onBack }: { onBack: () => void }) {
  const load = useContext(VerificationGuideSource);
  const live = load === getVerificationGuide;
  const { data, error, isPending } = useQuery({ queryKey: live ? ["verificationGuide"] : ["verificationGuide", "fixed"], queryFn: () => load(), staleTime: live ? 0 : Infinity });
  const bellman = data?.manifest.payload.verifierPolicy.verificationMethod === "bellman-transition-v1";
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="verify-title">
        <AmbientVideo className={styles.heroBg} src="/brand/hero-bg" poster="/brand/hero-bg-poster.webp" />
        <div className={styles.heroInner}>
          <h1 id="verify-title">Verify a contribution locally</h1>
          <p>Choose any accepted contribution. Check its signed receipt, then use the optional artifact check to verify the contribution on your computer.</p>
        </div>
      </section>
      <div className={styles.body}>
      {isPending && <p className={styles.state} role="status">Loading verification materials…</p>}
      {error && <p className={`${styles.state} ${styles.stateError}`} role="alert">Could not load verification materials: {error.message}</p>}
      {data && <div className={styles.guide}>
        <aside className={styles.scope} aria-labelledby="verify-scope">
        <h3 id="verify-scope">What will these checks establish?</h3>
        <ul>
          <li><strong>Receipt check:</strong> proves that the ceremony’s signing key signed the acceptance record for the contribution you choose.</li>
          <li><strong>Artifact check:</strong> {bellman ? "independently checks that the chosen contribution is exactly one valid transformation of its immediate predecessor." : "independently checks the chosen zkey against the circuit and Phase 1 transcript."}</li>
        </ul>
        </aside>
        <div className={styles.steps}>
        <section className={styles.step}>
        <h3>1. Fetch the pinned source</h3>
        <p>This snippet pins the source commit published in this browser build’s root-authorized release. If you already have the repository, enter it and start at <code>git fetch origin</code>.</p>
        <pre><code>{buildRepositorySetup(data.sourceCommit)}</code></pre>
        {data.local && <p>Use the existing <code>moss-phase2-hardening</code> worktree for this local test. The current development changes must be published before collaborators can fetch them.</p>}
        </section>
        <section className={styles.step}>
        <h3>2. Choose a contribution and download its receipt</h3>
        <p>On the ceremony homepage, find the contribution you want to check in <button type="button" className={styles.inlineLink} onClick={onBack}>Contribution history</button> (use the page controls for older entries). Expand its card and click <strong>Download signed receipt</strong>. Save it as <code>receipt.json</code>. Note its contribution number, which we call <strong>N</strong> below. You can choose any accepted contribution, regardless of who submitted it.</p>
        </section>
        <section className={styles.step}>
        <h3>3. Download the ceremony signing key</h3>
        <p>The coordinator signs every receipt with the ceremony signing key{data.signingKeys.length > 1 ? "s" : ""} below. The receipt’s <code>keyId</code> names the key that signed it. Download it and save it as <code>{SIGNING_KEY_FILE}</code>.</p>
        {data.signingKeys.map((key) => <div key={key.keyId} className={styles.signingKey}>
          <dl className={styles.fingerprint}>
            <dt>Key ID</dt><dd><code>{key.keyId}</code></dd>
            <dt>Fingerprint (SHA-256 of SPKI DER)</dt><dd><code>{key.spkiSha256}</code></dd>
          </dl>
          <pre><code>{key.publicKeyPem.trim()}</code></pre>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => download(SIGNING_KEY_FILE, key.publicKeyPem)}>Download signing key{data.signingKeys.length > 1 ? ` ${key.keyId}` : ""}</Button>
          </div>
        </div>)}
        <p>Check that the file you saved has the fingerprint above:</p>
        <pre><code>{`openssl pkey -pubin -in ${SIGNING_KEY_FILE} -outform DER | openssl dgst -sha256`}</code></pre>
        <dl className={styles.fingerprint}><dt>Ceremony ID</dt><dd><code>{data.ceremonyId}</code></dd></dl>
        </section>
        <section className={styles.step}>
        <h3>4. Verify the receipt offline</h3>
        <p>With Node.js 24+ and pnpm 10.29.2 installed, run from the pinned checkout’s root:</p>
        <pre><code>{CLIENT_BUILD}</code></pre>
        <p>Put <code>receipt.json</code> and <code>{SIGNING_KEY_FILE}</code> in that directory, or replace the paths below:</p>
        <pre><code>{data.command}</code></pre>
        <p>The verification command runs offline. It checks the receipt’s signature against the signing key, that the receipt belongs to this ceremony, and any contribution evidence saved in a CLI receipt. No login or private key is needed.</p>
        <p>A valid receipt proves the coordinator signed the acceptance record. It does not independently prove cryptographic validity or inclusion in the final ceremony output.</p>
        </section>
        <section className={styles.step}>
        <h3>5. Download the artifact files (optional cryptographic check)</h3>
        {bellman ? <>
          <p><code>contribution.params</code> is a local filename for the selected contribution’s Bellman artifact. You download this file; you do not generate it yourself.</p>
          <ol>
            <li>Expand contribution <strong>#N</strong> in <button type="button" className={styles.inlineLink} onClick={onBack}>Contribution history</button> and click <strong>Download contribution parameters</strong>. Rename the downloaded file to <code>contribution.params</code>.</li>
            <li>If <strong>N is 2 or greater</strong>, expand contribution <strong>#N−1</strong> and download its parameters as <code>predecessor.params</code>. Also download and verify that entry’s signed receipt separately.</li>
            <li>If <strong>N is 1</strong>, download the <strong>Bellman genesis</strong> linked below and save it as <code>predecessor.params</code>. Genesis is the starting artifact; it has no participant receipt. Check its hash and byte length against the genesis values below.</li>
          </ol>
          <p>The browser may save an artifact under a different filename or with a <code>.zkey</code> extension. For this Bellman ceremony, use the names above without converting the file. Renaming does not change its format or contents.</p>
          <p>Place both files in the checkout root. Compare <code>contribution.params</code> with the verified receipt’s <strong>successor</strong> hash and byte length, and <code>predecessor.params</code> with its <strong>predecessor</strong> hash and byte length. The previous receipt’s successor (or the genesis values for #1) must identify the same predecessor.</p>
          {data.manifest.payload.relation.genesisBellman && <ul className={styles.links}>{data.manifest.payload.relation.genesisBellman.urls.filter((value) => {
            try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
          }).map((url, index) => <li key={url}><a href={url} rel="noreferrer">Download Bellman genesis{index ? ` (copy ${index + 1})` : ""}</a> — predecessor for contribution #1</li>)}</ul>}
          <dl className={styles.fingerprint}>
            <dt>Genesis SHA-256</dt><dd><code>{data.genesis.sha256}</code></dd>
            <dt>Genesis bytes</dt><dd><code>{data.genesis.byteLength}</code></dd>
          </dl>
          <pre><code>{"shasum -a 256 predecessor.params contribution.params\nwc -c predecessor.params contribution.params"}</code></pre>
        </> : <>
        <p>Download the contribution’s zkey from its history card and save it as <code>contribution.zkey</code>. Compare its SHA-256 and byte length with the output printed by the receipt command:</p>
        <pre><code>{"shasum -a 256 contribution.zkey\nwc -c < contribution.zkey"}</code></pre>
        </>}
        </section>
        <section className={styles.step}>
        {bellman ? <>
          <h3>6. Verify the exact Bellman transition</h3>
          <p>Install Rust and build the native verifier from the pinned checkout:</p>
          <pre><code>{"pnpm --filter @moss/phase2-verifier-worker... build\ncargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml"}</code></pre>
          <p>Run the check with <strong>N−1</strong> as the final argument. For example, to check contribution <strong>#4</strong> against contribution <strong>#3</strong>:</p>
          <pre><code>{"node packages/bellman-verify/verify.mjs predecessor.params contribution.params 3"}</code></pre>
          <p>For contribution <strong>#1</strong> against genesis, use <code>0</code> instead of <code>3</code>. Do not use genesis as the predecessor for later contributions.</p>
          <p>This checks the unchanged transcript prefix, exactly one appended contribution, and the cryptographic transition. Compare the printed hashes, lengths and contribution identifier with the authenticated records. No R1CS, PTAU or zkey conversion is needed for this transition check.</p>
          <p>A passing result establishes this one transition relative to the authenticated predecessor.</p>
                </> : <>
        <h3>6. Rerun the full zkey check</h3>
        <p>This separate, more expensive check needs the contribution zkey plus the pinned circuit R1CS and PTAU. Obtain the R1CS and PTAU from the organizer’s published artifact locations and check them against the SHA-256 values listed below. For this circuit they are approximately 232 MB and 19.3 GB.</p>
        {data.local && <p>The local development manifest has no public R1CS/PTAU download URLs. The local operator’s files are <code>artifacts/moonsong-local/circuit.r1cs</code> and <code>artifacts/moonsong-local/powersoftau.ptau</code>; use those for this test. Hosted organizers must publish immutable copies before opening.</p>}
        {!data.local && <ul className={styles.links}>{["r1cs", "ptau"].map((kind) => {
          const artifact = data.manifest.payload.relation[kind as "r1cs" | "ptau"];
          return <li key={kind}>{kind.toUpperCase()}: {artifact.urls.filter((url) => {
            try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password; } catch { return false; }
          }).map((url, index) => <a key={url} href={url} rel="noreferrer">Download published copy {index + 1}</a>)}<br /><code>SHA-256: {artifact.sha256}</code></li>;
        })}</ul>}
        <p>With copies named <code>circuit.r1cs</code>, <code>powersoftau.ptau</code> and <code>contribution.zkey</code> in the checkout root, run:</p>
        <pre><code>{"pnpm --filter @moss/phase2-ceremony-cli exec snarkjs zkey verify \\\n  ../../circuit.r1cs ../../powersoftau.ptau ../../contribution.zkey"}</code></pre>
        <p>This checks zkey validity against the circuit and Phase 1 transcript. It does not establish the server’s exact predecessor-plus-one check or final transcript inclusion. Keep your receipt for the final ceremony audit.</p>
                </>}
        </section>
        </div>
      </div>}
      <div className={styles.back}>
        <Button variant="secondary" size="small" onClick={onBack}>Back to contribution history</Button>
      </div>
      </div>
    </div>
  );
}
