#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import { publishFinalization } from "./publish.js";
import { AwsPublicationStore } from "./s3.js";

const MIB = 1024 * 1024;
const FLAGS = new Set([
  "--finalizer-output",
  "--audit-report",
  "--proof-evidence",
  "--bucket",
  "--region",
  "--public-base-url",
  "--label",
  "--journal",
  "--index-out",
  "--minimum-retention-until",
  "--part-size-mib",
]);

export async function runPublishCli(argv: readonly string[]): Promise<void> {
  const values = parseFlags(argv);
  const partSizeMib = values.get("--part-size-mib");
  const partSizeBytes = partSizeMib === undefined ? undefined : boundedMib(partSizeMib);
  const minimumRetentionUntil = values.get("--minimum-retention-until");
  const store = new AwsPublicationStore(
    new S3Client({ region: required(values, "--region") }),
    required(values, "--bucket"),
  );
  await store.assertConfiguration({ requireObjectLock: minimumRetentionUntil !== undefined });
  const result = await publishFinalization({
    finalizerOutputDir: resolve(required(values, "--finalizer-output")),
    ...(values.has("--audit-report") ? { auditReportPath: resolve(values.get("--audit-report")!) } : {}),
    ...(values.has("--proof-evidence") ? { proofEvidencePath: resolve(values.get("--proof-evidence")!) } : {}),
    label: required(values, "--label"),
    publicBaseUrl: required(values, "--public-base-url"),
    journalPath: resolve(required(values, "--journal")),
    ...(values.has("--index-out") ? { indexOutPath: resolve(values.get("--index-out")!) } : {}),
    ...(minimumRetentionUntil ? { minimumRetentionUntil } : {}),
    ...(partSizeBytes ? { partSizeBytes, singlePutMaxBytes: partSizeBytes } : {}),
  }, { store });
  process.stdout.write(`${JSON.stringify({ status: "published", index: result.index })}\n`);
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag)) throw new Error(`unknown publish flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for publish flag: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate publish flag: ${flag}`);
    values.set(flag, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`required publish flag is missing: ${flag}`);
  return value;
}

/** S3 rejects non-final parts under 5 MiB; parts over 5 GiB are invalid too. */
function boundedMib(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("--part-size-mib must be a positive integer");
  const mib = Number(value);
  if (mib < 5 || mib > 5120) throw new Error("--part-size-mib must be from 5 through 5120");
  return mib * MIB;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  void runPublishCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`Publication failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
