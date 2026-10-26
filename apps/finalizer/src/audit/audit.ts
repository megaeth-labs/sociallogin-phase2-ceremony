import { createHash, createPublicKey } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalSha256,
  canonicalize,
  contributionGenesis,
  type CeremonyManifestV1,
  type ContributionReceiptV1,
  type JsonValue,
  type PrimaryPublication,
  type RehearsalWebReleaseAuthorization,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

import { loadFinalizationAuthority } from "../authority.js";
import { Findings, auditRecords, type OperationalUpdateHistory, type RecordsResult } from "./records.js";
import { replayTransitions } from "./replay.js";
import {
  AUDIT_CHECKS,
  CEREMONY_AUDIT_FILE,
  CEREMONY_AUDIT_RUN_FILE,
  CEREMONY_AUDIT_TYPE,
  REPLAY_STATE_FILE,
  type AuditCheckResult,
  type AuditFetcher,
  type AuditToolchain,
  type CeremonyAuditReportV1,
  type CeremonyAuditRunV1,
  type TransitionRunner,
} from "./types.js";

export interface AuditOptions {
  allowRehearsal?: boolean;
  manifestEnvelopePath: string;
  rootPublicKeyPath: string;
  expectedRootKeyId: string;
  expectedRootKeySpkiSha256: string;
  sealedCheckpointEnvelopePath: string;
  expectedSealedHeadSha256: string;
  expectedSealedHeadByteLength: number;
  publications: SignedEnvelope<PrimaryPublication>[];
  operationalUpdates: OperationalUpdateHistory | null;
  receipts?: SignedEnvelope<ContributionReceiptV1>[];
  webReleaseAuthorizations?: SignedEnvelope<RehearsalWebReleaseAuthorization>[];
  /** Persistent: holds the resume state, scratch space and both output files. */
  workDir: string;
  scope: "full" | "records";
  jobs?: number;
  chunkSize?: number;
}

export interface AuditDependencies {
  fetcher: AuditFetcher;
  /** Required for scope "full". */
  runner?: TransitionRunner;
  now?: () => Date;
  signal?: AbortSignal;
  /** Path of the Cargo.lock that built the native verifier, if known. */
  bellmanCargoLockPath?: string;
  onTransition?: (entry: { generation: number; result: string; seconds: number | null }) => void;
}

export interface AuditOutcome {
  report: CeremonyAuditReportV1;
  run: CeremonyAuditRunV1;
  reportPath: string;
  runPath: string;
  reportSha256: string;
}

/**
 * Audits a sealed ceremony from its signed records and, for scope "full",
 * replays every transition. Always writes a report; result is "passed" only
 * when every check ran and nothing failed.
 */
export async function auditCeremony(options: AuditOptions, dependencies: AuditDependencies): Promise<AuditOutcome> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const findings = new Findings();
  await mkdir(options.workDir, { recursive: true });

  let identity: Pick<CeremonyAuditReportV1, "ceremonyId" | "manifestSha256" | "manifestEnvelopeSha256" | "rootKeyId"
    | "rootKeySpkiSha256" | "purpose" | "verificationMethod" | "sealed" | "genesis"> = {
    ceremonyId: null, manifestSha256: null, manifestEnvelopeSha256: null, rootKeyId: null, rootKeySpkiSha256: null,
    purpose: null, verificationMethod: null, sealed: null, genesis: null,
  };
  let records: RecordsResult | undefined;
  let transitions: CeremonyAuditReportV1["transitions"] = [];
  let timings: CeremonyAuditRunV1["transitions"] = [];

  findings.item("authority");
  const authority = await findings.attempt("authority", null, async () => {
    const loaded = await loadFinalizationAuthority({ ...options, allowRehearsal: options.allowRehearsal ?? false });
    const { manifest, checkpoint } = loaded;
    if (!manifest.primaryPublication || manifest.publication) {
      throw new Error("audit supports only the coordinator-signed primary publication policy");
    }
    if (checkpoint.issuedAt < manifest.schedule.sealsAt) throw new Error("sealed checkpoint predates the manifest sealing time");
    const manifestEnvelope = JSON.parse(await readFile(options.manifestEnvelopePath, "utf8")) as SignedEnvelope<CeremonyManifestV1>;
    if (createHash("sha256").update(await readFile(options.manifestEnvelopePath)).digest("hex") !== loaded.manifestEnvelopeSha256) {
      throw new Error("manifest changed while it was being audited");
    }
    const rootPublicKey = createPublicKey(await readFile(options.rootPublicKeyPath, "utf8"));
    return { ...loaded, manifestEnvelope, rootPublicKey };
  });

  if (authority) {
    const { manifest, checkpoint } = authority;
    const manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest as unknown as JsonValue);
    const genesis = contributionGenesis(manifest);
    identity = {
      ceremonyId: manifest.ceremonyId,
      manifestSha256,
      manifestEnvelopeSha256: authority.manifestEnvelopeSha256,
      rootKeyId: authority.manifestRootKeyId,
      rootKeySpkiSha256: authority.manifestRootKeySpkiSha256,
      purpose: manifest.purpose ?? "production",
      verificationMethod: manifest.verifierPolicy.verificationMethod ?? "snarkjs-zkey-v1",
      sealed: {
        generation: checkpoint.generation, headSha256: checkpoint.headSha256, headByteLength: checkpoint.headByteLength,
        eventSequence: checkpoint.eventSequence, eventHash: checkpoint.eventHash,
        checkpointEnvelopeSha256: authority.checkpointEnvelopeSha256, checkpointSignerKeyId: authority.checkpointSignerKeyId,
      },
      genesis: { sha256: genesis.sha256, byteLength: genesis.byteLength },
    };
    records = await auditRecords({
      manifestEnvelope: authority.manifestEnvelope, manifest, manifestSha256, rootPublicKey: authority.rootPublicKey,
      checkpoint, publications: options.publications, operationalUpdates: options.operationalUpdates,
      receipts: options.receipts, webReleaseAuthorizations: options.webReleaseAuthorizations,
      allowRehearsal: options.allowRehearsal ?? false, fetcher: dependencies.fetcher,
    }, findings);

    if (options.scope === "full") {
      if (manifest.verifierPolicy.verificationMethod !== "bellman-transition-v1") {
        findings.fail("replay", null, "transition replay supports only bellman-transition-v1 ceremonies");
      } else if (!dependencies.runner) {
        findings.fail("replay", null, "no native transition verifier was configured");
      } else {
        const replay = await replayTransitions({
          links: records.links, sealedGeneration: checkpoint.generation, fetcher: dependencies.fetcher,
          runner: dependencies.runner, workDir: options.workDir, statePath: join(options.workDir, REPLAY_STATE_FILE),
          jobs: options.jobs ?? 1, chunkSize: options.chunkSize ?? 16, signal: dependencies.signal,
          onTransition: dependencies.onTransition,
        }, findings);
        transitions = replay.transitions;
        timings = replay.timings;
      }
    }
  }

  const checks = Object.fromEntries(AUDIT_CHECKS.map((name) => {
    const failures = findings.failures.filter((failure) => failure.check === name).length;
    const result: AuditCheckResult = {
      result: failures > 0 ? "failed" : findings.ran.has(name) ? "passed" : "not-run",
      items: findings.items.get(name) ?? 0,
      failures,
    };
    return [name, result];
  })) as CeremonyAuditReportV1["checks"];
  const requiredChecks = AUDIT_CHECKS.filter((name) => options.scope === "full" || name !== "replay");
  const passed = findings.failures.length === 0 && requiredChecks.every((name) => checks[name].result === "passed");

  const report: CeremonyAuditReportV1 = {
    schemaVersion: 1,
    type: CEREMONY_AUDIT_TYPE,
    scope: options.scope,
    result: passed ? "passed" : "failed",
    ...identity,
    counts: {
      contributions: records?.counts.contributions ?? 0,
      distinctParticipants: records?.counts.distinctParticipants ?? 0,
      publicationBundles: records?.counts.publicationBundles ?? 0,
      verifierReports: records?.counts.verifierReports ?? 0,
      operationalUpdates: records?.counts.operationalUpdates ?? 0,
      browserContributions: records?.counts.browserContributions ?? 0,
      cliContributions: records?.counts.cliContributions ?? 0,
      otherContributions: records?.counts.otherContributions ?? 0,
      transitionsReplayed: transitions.filter((entry) => entry.result === "valid").length,
    },
    checks,
    transitions,
    failures: [...findings.failures].sort((a, b) =>
      (a.generation ?? -1) - (b.generation ?? -1) || a.check.localeCompare(b.check) || a.message.localeCompare(b.message)),
    toolchain: await toolchain(dependencies),
  };

  const bytes = Buffer.from(canonicalize(report as unknown as JsonValue), "utf8");
  const reportSha256 = createHash("sha256").update(bytes).digest("hex");
  const reportPath = join(options.workDir, CEREMONY_AUDIT_FILE);
  await atomicWrite(reportPath, bytes);
  const run: CeremonyAuditRunV1 = {
    schemaVersion: 1,
    type: "moss.phase2.ceremony-audit-run.v1",
    auditSha256: reportSha256,
    auditByteLength: bytes.byteLength,
    startedAt,
    finishedAt: now().toISOString(),
    jobs: options.jobs ?? 1,
    source: dependencies.fetcher.kind,
    transitions: timings,
  };
  const runPath = join(options.workDir, CEREMONY_AUDIT_RUN_FILE);
  await atomicWrite(runPath, Buffer.from(`${JSON.stringify(run, null, 2)}\n`));
  return { report, run, reportPath, runPath, reportSha256 };
}

async function toolchain(dependencies: AuditDependencies): Promise<AuditToolchain> {
  const here = dirname(fileURLToPath(import.meta.url));
  const own = JSON.parse(await readFile(resolve(here, "../../package.json"), "utf8")) as { version: string };
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    auditor: { package: "@moss/phase2-finalizer", version: own.version },
    protocolVersion: await packageVersion("@moss/phase2-protocol"),
    zkeyInspectVersion: await packageVersion("@moss/phase2-zkey-inspect"),
    snarkjsVersion: await packageVersion("snarkjs"),
    bellmanVerifier: {
      binarySha256: dependencies.runner?.binarySha256 ?? null,
      phase2Bn254Revision: await phase2Revision(dependencies.bellmanCargoLockPath
        ?? resolve(here, "../../../../packages/bellman-verify/Cargo.lock")),
    },
  };
}

async function packageVersion(name: string): Promise<string | null> {
  try {
    // import.meta.resolve honours ESM-only "exports"; walk up to the package root.
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    for (let depth = 0; depth < 6; depth += 1) {
      const value = await readFile(join(directory, "package.json"), "utf8").then(
        (text) => JSON.parse(text) as { name?: string; version?: string }, () => undefined);
      if (value?.name === name && typeof value.version === "string") return value.version;
      directory = dirname(directory);
    }
  } catch { /* not resolvable */ }
  return null;
}

async function phase2Revision(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  const match = text?.match(/source = "git\+https:\/\/github\.com\/MystenLabs\/phase2-bn254\?rev=[a-f0-9]{40}#([a-f0-9]{40})"/u);
  return match?.[1] ?? null;
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, path);
}
