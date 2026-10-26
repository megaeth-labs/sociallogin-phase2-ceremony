#!/usr/bin/env node
// Rebuild one commit several times with infra/docker/Dockerfile.web-release and
// require every web-release.json to be byte-identical. This is the verifier's
// reproduction path, so a flaky asset shows up here before a release is pinned.
// It is slow (one full Linux AMD64 build per run) and deliberately not part of
// the test suite.
//
//   node infra/web-release-reproducibility.mjs [--commit <rev>] [--runs <n>]
//
// Public build arguments come from the environment (MOSS_WEB_BUILD_ID,
// NEXT_DEPLOYMENT_ID, COORDINATOR_BASE_URL, ARTIFACT_ORIGINS,
// NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED, NODE_IMAGE); placeholders are used
// when unset, which is enough to test determinism but not to match a deployment.
// DOCKER_BUILDER selects the buildx builder (default: desktop-linux).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!["--commit", "--runs"].includes(process.argv[index])) {
    throw new Error(`unknown flag: ${process.argv[index]}`);
  }
  args.set(process.argv[index], process.argv[index + 1]);
}
const commit = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${args.get("--commit") ?? "HEAD"}^{commit}`], { encoding: "utf8" }).trim();
const runs = Number(args.get("--runs") ?? 2);
if (!Number.isInteger(runs) || runs < 2) throw new Error("--runs must be an integer of at least 2");

const env = process.env;
const buildArgs = {
  NODE_IMAGE: env.NODE_IMAGE ?? "node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
  MOSS_WEB_BUILD_ID: env.MOSS_WEB_BUILD_ID ?? commit,
  NEXT_DEPLOYMENT_ID: env.NEXT_DEPLOYMENT_ID ?? "dpl_reproducibility",
  COORDINATOR_BASE_URL: env.COORDINATOR_BASE_URL ?? "https://coordinator.example",
  ARTIFACT_ORIGINS: env.ARTIFACT_ORIGINS ?? "https://artifacts.example",
  NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED: env.NEXT_PUBLIC_BROWSER_CONTRIBUTIONS_ENABLED ?? "true",
};

// The build context holds only the archived commit and the Dockerfile at that
// commit, plus a scratch stage that exports /web-release.json without
// creating an image or container.
const context = mkdtempSync(join(tmpdir(), "web-release-repro-"));
try {
  execFileSync("git", ["-C", repo, "archive", "--format=tar", "-o", join(context, "source.tar"), commit]);
  const dockerfile = execFileSync("git", ["-C", repo, "show", `${commit}:infra/docker/Dockerfile.web-release`], { encoding: "utf8" });
  writeFileSync(join(context, "Dockerfile"), `${dockerfile}\nFROM scratch AS web-release-export\nCOPY --from=0 /web-release.json /web-release.json\n`);

  const digests = [];
  for (let run = 1; run <= runs; run += 1) {
    const out = join(context, `out-${run}`);
    execFileSync("docker", [
      "buildx", "build", "--builder", env.DOCKER_BUILDER ?? "desktop-linux",
      "--platform", "linux/amd64", "--no-cache", "--target", "web-release-export",
      "--output", `type=local,dest=${out}`,
      ...Object.entries(buildArgs).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
      context,
    ], { stdio: ["ignore", "ignore", "inherit"] });
    const bytes = readFileSync(join(out, "web-release.json"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    digests.push(digest);
    process.stdout.write(`run ${run}: web-release.json sha256 ${digest}\n`);
    if (digest !== digests[0]) {
      const assets = (path) => new Set(JSON.parse(readFileSync(path, "utf8")).assets.map((asset) => `${asset.path} ${asset.sha256}`));
      const first = assets(join(context, "out-1", "web-release.json"));
      const current = assets(join(out, "web-release.json"));
      for (const entry of first) if (!current.has(entry)) process.stdout.write(`  only in run 1: ${entry}\n`);
      for (const entry of current) if (!first.has(entry)) process.stdout.write(`  only in run ${run}: ${entry}\n`);
    }
  }
  if (new Set(digests).size !== 1) {
    process.stderr.write(`\n${commit} is not reproducible: ${new Set(digests).size} distinct web-release.json digests in ${runs} builds\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${commit}: ${runs} clean builds produced identical web-release.json\n`);
  }
} finally {
  rmSync(context, { recursive: true, force: true });
}
