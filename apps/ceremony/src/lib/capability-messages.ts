import type { BrowserContributionCapabilities } from "@wonderland/cabure-crypto";

/**
 * Turn the probe's machine-readable reason codes into something a contributor
 * can act on without promising an unavailable contribution client.
 */
const REASON_MESSAGES: Record<string, string> = {
  "secure-context-required":
    "This page is not running in a secure context. Open it over HTTPS.",
  "opfs-unavailable":
    "This browser has no Origin Private File System, which the contribution needs in order to stream the key without holding it in memory.",
  "opfs-sync-access-unavailable":
    "The browser worker could not open temporary contribution storage. Try an up-to-date desktop browser in a normal window, then run the check again.",
  "streaming-fetch-unavailable":
    "This browser cannot stream a fetch response, which the contribution needs in order to download the key incrementally.",
  "web-crypto-unavailable":
    "This browser exposes no Web Crypto API, so contribution entropy cannot be generated safely here.",
  "storage-estimate-failed":
    "This browser refused to report its storage quota, so the contribution cannot confirm there is room for the key.",
  "storage-estimate-unavailable":
    "This browser cannot report its storage quota, so the contribution cannot confirm there is room for the key.",
  "insufficient-opfs-quota":
    "There is not enough browser storage quota for the key.",
};

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Build a contributor-facing explanation. Quota shortfalls carry the actual
 * numbers, because "free up space" is useless without knowing how much.
 */
export function describeBrowserCapabilityFailure(
  capabilities: BrowserContributionCapabilities,
): string {
  const lines = capabilities.reasons.map(
    (reason) => REASON_MESSAGES[reason] ?? `Unsupported browser capability: ${reason}.`,
  );

  if (
    capabilities.reasons.includes("insufficient-opfs-quota") &&
    capabilities.requiredBytes !== undefined &&
    capabilities.availableBytes !== undefined
  ) {
    lines.push(
      `This contribution needs ${formatGiB(capabilities.requiredBytes)} and this browser offers ${formatGiB(capabilities.availableBytes)}. Free up disk space and run the check again.`,
    );
  }

  lines.push("If the check still fails, contact the ceremony operator with the error and your browser version.");
  return lines.join(" ");
}
