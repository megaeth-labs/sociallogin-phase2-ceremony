import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CeremonyManifestV1 } from "@moss/phase2-protocol";

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Hash the running bundle and require the ceremony to authorize it: the signed
 * manifest's cliReleases, or a later root-signed update when the manifest
 * allows CLI release updates.
 *
 * The release hash cannot be embedded at build time: it is the hash of the
 * built artifact, so embedding it changes the artifact and therefore changes
 * the hash. That never converges, and pinning either value leaves the other
 * wrong. Reading the bundle back at run time sidesteps the self-reference
 * entirely, and has the side benefit of describing the file actually
 * executing rather than a value someone passed in.
 *
 * This is allowlisting, not attestation. A modified CLI can report anything it
 * likes, exactly as `README.md` says of a client release hash. What it does
 * give is a truthful answer from an honest build, and a coordinator-side record
 * of which releases were used.
 *
 * `modulePath` exists so tests can hash a fixture instead of themselves; it is
 * never supplied in normal operation.
 */
export async function resolveCliReleaseSha256(
  manifest: CeremonyManifestV1,
  options: { modulePath?: string; updatedReleases?: () => Promise<string[]> } = {},
): Promise<string | undefined> {
  if (!manifest.contributionPolicy.requirePinnedClientRelease) return undefined;

  const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
  let sha256: string;
  try {
    sha256 = createHash("sha256").update(await readFile(modulePath)).digest("hex");
  } catch {
    throw new Error(
      "This ceremony requires a pinned CLI release, but this build could not read itself to compute its own hash.",
    );
  }
  if (!SHA256.test(sha256)) throw new Error("computed CLI release hash is malformed");

  if (manifest.cliReleases.some((release) => release.sha256 === sha256)) return sha256;
  // Fetched only when needed: most runs use a build the manifest itself pins.
  if (options.updatedReleases && manifest.operationalPolicy?.allowCliReleaseUpdates === true
    && (await options.updatedReleases()).includes(sha256)) return sha256;
  throw new Error(
    `This CLI build (${sha256}) is not authorized by the signed ceremony manifest or its updates. Use a release published by the ceremony operator.`,
  );
}
