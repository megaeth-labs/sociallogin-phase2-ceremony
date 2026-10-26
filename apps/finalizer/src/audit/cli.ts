#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  CeremonyManifestV1,
  ContributionReceiptV1,
  PrimaryPublication,
  RehearsalWebReleaseAuthorization,
  SignedEnvelope,
} from "@moss/phase2-protocol";

import { auditCeremony } from "./audit.js";
import { DirectoryFetcher, HttpFetcher } from "./fetcher.js";
import type { OperationalUpdateHistory } from "./records.js";
import { NativeBellmanTransitionRunner } from "./runner.js";
import type { AuditFetcher } from "./types.js";

const SINGLE = new Set([
  "--manifest", "--root-key", "--root-key-id", "--root-key-spki-sha256",
  "--sealed-checkpoint", "--sealed-head-sha256", "--sealed-head-byte-length",
  "--publications", "--operational-updates", "--receipts", "--coordinator-url",
  "--mirror", "--work-dir", "--bellman-verifier", "--jobs", "--chunk-size",
  "--transition-timeout-ms", "--http-timeout-ms", "--http-attempts",
]);
const REPEATED = new Set(["--web-release-authorization"]);
const SWITCHES = new Set(["--records-only", "--allow-rehearsal"]);
const MAX_INPUT_BYTES = 256 * 1024 * 1024;

export async function runAuditCli(argv: readonly string[]): Promise<number> {
  const { single, repeated, switches } = parseFlags(argv);
  const scope = switches.has("--records-only") ? "records" : "full";
  const http = new HttpFetcher({
    timeoutMs: bounded(single, "--http-timeout-ms", 1_000, 600_000),
    attempts: bounded(single, "--http-attempts", 1, 20),
  });
  const fetcher: AuditFetcher = single.has("--mirror") ? new DirectoryFetcher(resolve(single.get("--mirror")!)) : http;
  const manifestPath = resolve(required(single, "--manifest"));

  let publications: SignedEnvelope<PrimaryPublication>[];
  let operationalUpdates: OperationalUpdateHistory | null;
  let receipts: SignedEnvelope<ContributionReceiptV1>[] | undefined;
  const coordinator = single.get("--coordinator-url");
  if (coordinator !== undefined) {
    if (single.has("--publications")) throw new Error("use either --publications or --coordinator-url");
    // The slug only selects URLs; everything fetched is authenticated by the audit.
    const slug = (JSON.parse(await readFile(manifestPath, "utf8")) as SignedEnvelope<CeremonyManifestV1>).payload.slug;
    const records = await fetchCoordinatorRecords(http, coordinator, slug);
    publications = records.publications;
    operationalUpdates = single.has("--operational-updates") ? await readOperationalUpdates(single.get("--operational-updates")!) : records.operationalUpdates;
    receipts = single.has("--receipts") ? await readList(single.get("--receipts")!, "receipts") : records.receipts;
  } else {
    publications = await readList(required(single, "--publications"), "acknowledgements");
    operationalUpdates = single.has("--operational-updates") ? await readOperationalUpdates(single.get("--operational-updates")!) : null;
    receipts = single.has("--receipts") ? await readList(single.get("--receipts")!, "receipts") : undefined;
  }
  const webReleaseAuthorizations = await Promise.all((repeated.get("--web-release-authorization") ?? [])
    .map(async (path) => await readJson(path) as SignedEnvelope<RehearsalWebReleaseAuthorization>));

  const verifierPath = resolve(single.get("--bellman-verifier")
    ?? fileURLToPath(new URL("../../../../packages/bellman-verify/target/release/moss-bellman-verify", import.meta.url)));
  const runner = scope === "full"
    ? await NativeBellmanTransitionRunner.create(verifierPath, bounded(single, "--transition-timeout-ms", 1_000, 86_400_000))
    : undefined;

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const outcome = await auditCeremony({
      allowRehearsal: switches.has("--allow-rehearsal"),
      manifestEnvelopePath: manifestPath,
      rootPublicKeyPath: resolve(required(single, "--root-key")),
      expectedRootKeyId: required(single, "--root-key-id"),
      expectedRootKeySpkiSha256: required(single, "--root-key-spki-sha256"),
      sealedCheckpointEnvelopePath: resolve(required(single, "--sealed-checkpoint")),
      expectedSealedHeadSha256: required(single, "--sealed-head-sha256"),
      expectedSealedHeadByteLength: bounded(single, "--sealed-head-byte-length", 1, Number.MAX_SAFE_INTEGER, true)!,
      publications, operationalUpdates, receipts, webReleaseAuthorizations,
      workDir: resolve(required(single, "--work-dir")),
      scope,
      jobs: bounded(single, "--jobs", 1, 64),
      chunkSize: bounded(single, "--chunk-size", 1, 100_000),
    }, {
      fetcher,
      runner,
      bellmanCargoLockPath: resolve(verifierPath, "../../../Cargo.lock"),
      signal: controller.signal,
      onTransition: (entry) => process.stderr.write(`${JSON.stringify({ transition: entry.generation, result: entry.result, seconds: entry.seconds })}\n`),
    });
    process.stdout.write(`${JSON.stringify({
      result: outcome.report.result,
      scope: outcome.report.scope,
      reportPath: outcome.reportPath,
      reportSha256: outcome.reportSha256,
      runPath: outcome.runPath,
      failures: outcome.report.failures.length,
    })}\n`);
    for (const failure of outcome.report.failures.slice(0, 50)) {
      process.stderr.write(`FAIL ${failure.check}${failure.generation === null ? "" : ` #${failure.generation}`}: ${failure.message}\n`);
    }
    return outcome.report.result === "passed" ? 0 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/** Pages through the coordinator's public, signed records. */
async function fetchCoordinatorRecords(http: HttpFetcher, base: string, slug: string) {
  const origin = new URL(base);
  const api = (path: string) => new URL(`/v1/ceremonies/${encodeURIComponent(slug)}${path}`, origin).toString();
  const json = async (url: string) => JSON.parse((await http.fetchBytes(url, 16 * 1024 * 1024)).toString("utf8")) as Record<string, unknown>;
  const publications: SignedEnvelope<PrimaryPublication>[] = [];
  for (let after = -1; ;) {
    // The first page omits `after`: the coordinator reads that as "from the
    // start" and rejects negative values.
    const page = (await json(api(after < 0 ? "/publications" : `/publications?after=${after}`))).acknowledgements as SignedEnvelope<PrimaryPublication>[];
    if (!Array.isArray(page) || page.length === 0) break;
    publications.push(...page);
    const last = page.at(-1)!.payload.eventSequence;
    if (!Number.isSafeInteger(last) || last <= after) throw new Error("coordinator publication pages do not advance");
    after = last;
  }
  const receipts: SignedEnvelope<ContributionReceiptV1>[] = [];
  for (let after = 0; ;) {
    const page = (await json(api(`/contributions?after=${after}`))).receipts as SignedEnvelope<ContributionReceiptV1>[];
    if (!Array.isArray(page) || page.length === 0) break;
    receipts.push(...page);
    const last = page.at(-1)!.payload.generation;
    if (!Number.isSafeInteger(last) || last <= after) throw new Error("coordinator receipt pages do not advance");
    after = last;
  }
  const operationalUpdates = await json(api("/operational-updates")) as unknown as OperationalUpdateHistory;
  return { publications, receipts, operationalUpdates };
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(resolve(path));
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error(`${path} is too large`);
  return JSON.parse(bytes.toString("utf8"));
}

/** Accepts an array, an API page ({ key: [...] }) or an array of pages. */
async function readList<T>(path: string, key: string): Promise<T[]> {
  const value = await readJson(path);
  const pages = Array.isArray(value) && value.every((entry) => entry && typeof entry === "object" && key in entry) ? value : [value];
  return pages.flatMap((page) => Array.isArray(page) ? page : (page as Record<string, T[]>)[key] ?? []) as T[];
}

async function readOperationalUpdates(path: string): Promise<OperationalUpdateHistory> {
  const value = await readJson(path);
  return Array.isArray(value) ? { updates: value } : value as OperationalUpdateHistory;
}

function parseFlags(argv: readonly string[]) {
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (SWITCHES.has(flag)) {
      if (switches.has(flag)) throw new Error(`duplicate audit flag: ${flag}`);
      switches.add(flag);
      continue;
    }
    const value = argv[index + 1];
    if (!SINGLE.has(flag) && !REPEATED.has(flag)) throw new Error(`unknown audit flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for audit flag: ${flag}`);
    index += 1;
    if (REPEATED.has(flag)) repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    else if (single.has(flag)) throw new Error(`duplicate audit flag: ${flag}`);
    else single.set(flag, value);
  }
  return { single, repeated, switches };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`required audit flag is missing: ${flag}`);
  return value;
}

function bounded(values: ReadonlyMap<string, string>, flag: string, minimum: number, maximum: number, mandatory = false): number | undefined {
  const value = values.get(flag);
  if (value === undefined) {
    if (mandatory) throw new Error(`required audit flag is missing: ${flag}`);
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${flag} must be from ${minimum} through ${maximum}`);
  return parsed;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runAuditCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`Audit failed to run: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
  });
}
