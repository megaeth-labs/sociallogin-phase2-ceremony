export const REPOSITORY_SETUP = [
  "git clone https://github.com/megaeth-labs/sociallogin-phase2-ceremony.git",
  "cd sociallogin-phase2-ceremony",
  "git fetch origin",
  "git checkout --detach REVIEWED_RELEASE_COMMIT",
].join("\n");

/** Use only a full source hash obtained from an authenticated release reference. */
export function buildRepositorySetup(sourceCommit: string): string {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Invalid reviewed source commit.");
  return REPOSITORY_SETUP.replace("REVIEWED_RELEASE_COMMIT", sourceCommit);
}

export const CLIENT_BUILD = [
  "pnpm install --frozen-lockfile",
  "pnpm --filter @moss/phase2-protocol build",
  "pnpm --filter @moss/phase2-ceremony-cli build",
].join("\n");

/** Where the receipt command expects the downloaded signing key. */
export const SIGNING_KEY_FILE = "ceremony-signing-key.pub";

const SHELL_CONTINUATION = " " + String.fromCharCode(92, 10) + "  ";

/** Keep displayed commands safe to paste into a POSIX shell. */
function quote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Whether the coordinator is a local development stack. */
export function isLocalCoordinator(coordinatorBaseUrl: string): boolean {
  const url = new URL(coordinatorBaseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Verification instructions require HTTPS or loopback HTTP origins.");
  }
  return loopback;
}

/** The offline receipt check, against the published signing key and ceremony ID. */
export function buildReceiptVerificationCommand(input: { ceremonyId: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ceremonyId)) throw new Error("Invalid ceremony ID.");
  return [
    "node packages/cli/dist/index.js verify-receipt ./receipt.json",
    `--signing-key ./${SIGNING_KEY_FILE}`,
    `--ceremony-id ${quote(input.ceremonyId)}`,
  ].join(SHELL_CONTINUATION);
}
