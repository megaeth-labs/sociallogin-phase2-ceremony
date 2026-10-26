import { createHash, createPublicKey } from "node:crypto";
import { readServerMaterial } from "./server-material";

import {
  MANIFEST_SIGNATURE_DOMAIN,
  verifyRehearsalWebRelease,
  verifyOperationalUpdates,
  type OperationalUpdate,
  type RehearsalWebReleaseAuthorization,
  type ReleaseRef,
  assertManifest,
  ceremonyValidationOptions,
  verifyEnvelope,
  type CeremonyManifestV1,
  type SignedEnvelope,
} from "@moss/phase2-protocol";

import { requiredServerEnv } from "./server-env";

const MAX_MANIFEST_BYTES = 1_048_576;

export interface CoordinatorBootstrap {
  artifactOrigins?: string[];
  activeWebRelease?: ReleaseRef;
  /** Current heartbeat grace; an active lease keeps at least this much. */
  heartbeatGraceSeconds: number;
  webReleaseAuthorization?: SignedEnvelope<RehearsalWebReleaseAuthorization>;
  coordinatorBaseUrl: string;
  rootPublicKeyPem: string;
  rootSpkiSha256: string;
  manifest: SignedEnvelope<CeremonyManifestV1>;
}

/** Fetch and root-verify the immutable ceremony manifest before exposing it. */
export async function loadCoordinatorBootstrap(): Promise<CoordinatorBootstrap> {
  const coordinatorBaseUrl = normalizedCoordinatorUrl(
    requiredServerEnv("COORDINATOR_BASE_URL"),
  );
  const expectedSlug = requiredServerEnv("CEREMONY_SLUG");
  const manifestUrl = new URL(
    `/v1/ceremonies/${encodeURIComponent(expectedSlug)}/manifest`,
    coordinatorBaseUrl,
  );
  const response = await fetch(manifestUrl, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Coordinator manifest request failed (${response.status}).`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
    throw new Error("Coordinator manifest exceeds the size limit.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("Coordinator manifest exceeds the size limit.");
  }

  let envelope: SignedEnvelope<CeremonyManifestV1>;
  try {
    envelope = JSON.parse(raw) as SignedEnvelope<CeremonyManifestV1>;
  } catch {
    throw new Error("Coordinator manifest is not valid JSON.");
  }
  const expectedRootKeyId = requiredServerEnv("MANIFEST_ROOT_KEY_ID");
  if (envelope.keyId !== expectedRootKeyId) {
    throw new Error("Coordinator manifest root key id is not pinned.");
  }
  const rootPem = await readServerMaterial("MANIFEST_ROOT_PUBLIC_KEY", false);
  const rootKey = createPublicKey(rootPem);
  const rootDigest = createHash("sha256")
    .update(rootKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  if (
    rootDigest !==
    requiredServerEnv("MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256").toLowerCase()
  ) {
    throw new Error("Manifest root public key does not match the release pin.");
  }
  const payload = verifyEnvelope(envelope as never, {
    publicKey: rootKey,
    domain: MANIFEST_SIGNATURE_DOMAIN,
  }) as unknown as CeremonyManifestV1;
  assertManifest(payload, ceremonyValidationOptions(process.env.NODE_ENV, process.env.CEREMONY_MODE));
  if (payload.slug !== expectedSlug) {
    throw new Error("Coordinator manifest slug does not match this release.");
  }
  let webReleaseAuthorization: SignedEnvelope<RehearsalWebReleaseAuthorization> | undefined;
  let activeWebRelease = payload.webRelease;
  if (payload.purpose === "rehearsal") {
    const releaseResponse = await fetch(new URL(`/v1/ceremonies/${encodeURIComponent(expectedSlug)}/web-release-authorization`, coordinatorBaseUrl), {
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!releaseResponse.ok) throw new Error("Rehearsal web release authorization is unavailable.");
    const releaseRaw = await releaseResponse.text();
    if (Buffer.byteLength(releaseRaw, "utf8") > 65_536) throw new Error("Web release authorization exceeds the size limit.");
    const releaseEnvelope = JSON.parse(releaseRaw);
    if (releaseEnvelope !== null) {
      activeWebRelease = verifyRehearsalWebRelease(releaseEnvelope, envelope, rootKey).release;
      webReleaseAuthorization = releaseEnvelope;
    }
  }
  const allowedReleases = [payload.webRelease, activeWebRelease];
  // Mirrors the coordinator's heartbeat-policy baseline. Updates only raise an
  // ACTIVE lease's grace, so this current value never overstates a live slot.
  const signedGrace = payload.contributionPolicy.lease.heartbeatSeconds;
  let heartbeatGraceSeconds = payload.purpose === "rehearsal" ? Math.max(signedGrace, 300) : signedGrace;
  if (payload.operationalPolicy || payload.purpose === "rehearsal") {
    const response = await fetch(new URL(`/v1/ceremonies/${encodeURIComponent(expectedSlug)}/operational-updates`, coordinatorBaseUrl), {
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    // Legacy rehearsal coordinators predate the hot-update endpoint. Production opt-in fails closed.
    if (response.status !== 404 || payload.operationalPolicy) {
      if (!response.ok) throw new Error("Operational update history is unavailable.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 2_200_000) throw new Error("Operational update history exceeds size limit.");
      const { updates } = JSON.parse(text) as { updates: SignedEnvelope<OperationalUpdate>[] };
      verifyOperationalUpdates(updates, envelope, rootKey, payload.purpose === "rehearsal");
      for (const update of updates) {
        if (update.payload.webRelease) allowedReleases.push(update.payload.webRelease);
        heartbeatGraceSeconds = update.payload.heartbeatGraceSeconds ?? heartbeatGraceSeconds;
      }
    }
  }
  if (process.env.MOSS_WEB_BUILD_ID) {
    const sameCommit = allowedReleases.filter((release) => release.sourceCommit === process.env.MOSS_WEB_BUILD_ID);
    if (new Set(sameCommit.map((release) => release.sha256)).size > 1) throw new Error("Ambiguous browser release for this source commit.");
    const selected = allowedReleases.find((release) => release.sourceCommit === process.env.MOSS_WEB_BUILD_ID);
    if (!selected) throw new Error("This browser build has not been authorized for the ceremony.");
    activeWebRelease = selected;
  } else {
    activeWebRelease = allowedReleases.at(-1)!;
  }
  const artifactOrigins = (process.env.ARTIFACT_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean).map(value => new URL(value).origin);
  return { artifactOrigins, activeWebRelease, heartbeatGraceSeconds, ...(webReleaseAuthorization ? { webReleaseAuthorization } : {}), coordinatorBaseUrl, manifest: envelope, rootPublicKeyPem: rootPem, rootSpkiSha256: rootDigest };
}

function normalizedCoordinatorUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("COORDINATOR_BASE_URL contains forbidden URL components.");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Production coordinator URL must use HTTPS.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Coordinator URL protocol is unsupported.");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString();
}
