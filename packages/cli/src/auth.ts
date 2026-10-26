import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";

import type {
  CliAuthInitResponse,
  CliAuthTokenResponse,
  StoredAuth,
} from "./types.js";
import { sleep } from "./utils.js";

const AUTH_DIR = join(homedir(), ".moss-phase2-ceremony");
const AUTH_FILE = join(AUTH_DIR, "auth.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export async function loadStoredAuth(ceremonyUrl: string): Promise<StoredAuth | null> {
  try {
    await assertPrivateRegularFile(AUTH_FILE);
    const raw = await readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const value of parsed) {
      const auth = parseStoredAuth(value);
      if (auth?.ceremonyUrl !== ceremonyUrl) continue;
      if (auth.expiresAt <= Math.floor(Date.now() / 1_000)) return null;
      const claims = parseCompatibleParticipantToken(auth.token, auth.expiresAt);
      if (claims.participantId !== auth.participantId || claims.participantName !== auth.participantName) {
        return null;
      }
      return auth;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readTokenFile(path: string): Promise<string> {
  await assertPrivateRegularFile(path);
  const token = (await readFile(path, "utf8")).trim();
  assertCompatibleParticipantToken(token);
  return token;
}

export function assertCompatibleParticipantToken(token: string, expectedExpiry?: number): void {
  parseCompatibleParticipantToken(token, expectedExpiry);
}

export function inspectCompatibleParticipantToken(
  token: string,
  expectedExpiry?: number,
): { participantId: string; participantName: string; expiresAt: number } {
  return parseCompatibleParticipantToken(token, expectedExpiry);
}

function parseCompatibleParticipantToken(
  token: string,
  expectedExpiry?: number,
): { participantId: string; participantName: string; expiresAt: number } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) {
    throw new Error("Participant token is malformed.");
  }
  const header = decodeCanonicalJson(parts[0], "participant token header") as Record<string, unknown>;
  if (header.alg !== "EdDSA" || header.typ !== "JWT") {
    throw new Error("Participant token must be an Ed25519 EdDSA JWT accepted by the v1 coordinator.");
  }
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== parts[2]) {
    throw new Error("Participant token signature encoding is invalid.");
  }
  const claims = decodeCanonicalJson(parts[1], "participant token claims") as Record<string, unknown>;
  if (typeof claims.iss !== "string" || claims.iss.length === 0 || !validAudience(claims.aud)) {
    throw new Error("Participant token issuer or audience claim is missing.");
  }
  if (!Number.isSafeInteger(claims.exp) || Number(claims.exp) <= Math.floor(Date.now() / 1_000)) {
    throw new Error("Participant token is expired or has no valid expiry.");
  }
  if (expectedExpiry !== undefined && claims.exp !== expectedExpiry) {
    throw new Error("Participant token expiry does not match the auth response.");
  }
  if (typeof claims.sub !== "string" || !UUID.test(claims.sub)) {
    throw new Error("Participant token subject must be a canonical UUID.");
  }
  if (
    typeof claims.name !== "string" ||
    claims.name.length < 1 ||
    claims.name.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(claims.name)
  ) {
    throw new Error("Participant token pseudonym is invalid.");
  }
  if (typeof claims.ash !== "string" || !SHA256.test(claims.ash)) {
    throw new Error("Participant token auth-subject hash is invalid.");
  }
  return {
    participantId: claims.sub,
    participantName: claims.name,
    expiresAt: Number(claims.exp),
  };
}

export async function authenticate(input: {
  authUrl: string;
  ceremonyUrl: string;
}): Promise<StoredAuth> {
  const existing = await loadStoredAuth(input.ceremonyUrl);
  if (existing) return existing;

  const endpoint = deviceAuthEndpoint(input.authUrl);
  const initResponse = await fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const initBody = await responseJson(initResponse);
  if (!initResponse.ok) throw authResponseError("Failed to initiate auth", initResponse, initBody);
  const initialized = parseAuthInit(initBody);

  console.log(`\n  Visit ${initialized.verificationUri} and enter code: ${initialized.userCode}\n`);
  openBrowser(initialized.verificationUri);

  const pollUrl = deviceAuthEndpoint(input.authUrl);
  let pollInterval = initialized.interval * 1_000;
  const deadline = Date.now() + initialized.expiresIn * 1_000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const pollResponse = await fetch(
      pollUrl,
      deviceAuthPollRequest(initialized.loginCode),
    );
    const pollBody = await responseJson(pollResponse);
    if (pollResponse.status === 202) {
      const row = record(pollBody);
      if (row && Number.isSafeInteger(row.interval) && Number(row.interval) >= 1 && Number(row.interval) <= 60) {
        pollInterval = Number(row.interval) * 1_000;
      }
      continue;
    }
    if (!pollResponse.ok) throw authResponseError("Auth poll failed", pollResponse, pollBody);

    const data = parseAuthToken(pollBody);
    const claims = parseCompatibleParticipantToken(data.token, data.expiresAt);
    if (claims.participantId !== data.participantId || claims.participantName !== data.participantName) {
      throw new Error("Device-auth response metadata does not match its participant token.");
    }
    const auth: StoredAuth = {
      ceremonyUrl: input.ceremonyUrl,
      token: data.token,
      participantId: data.participantId,
      participantName: data.participantName,
      expiresAt: data.expiresAt,
    };
    await saveAuth(auth);
    console.log(`  Authenticated as ${data.participantName}\n`);
    return auth;
  }
  throw new Error("Device code expired. Run the command again to retry.");
}

/** Build a non-cacheable poll that keeps the one-time login code out of URLs. */
export function deviceAuthPollRequest(loginCode: string): RequestInit {
  if (!/^[a-f0-9]{32}$/u.test(loginCode)) {
    throw new Error("Device-auth login code is malformed.");
  }
  return {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ loginCode }),
  };
}

async function saveAuth(auth: StoredAuth): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  await chmod(AUTH_DIR, 0o700);
  let entries: StoredAuth[] = [];
  try {
    await assertPrivateRegularFile(AUTH_FILE);
    const parsed = JSON.parse(await readFile(AUTH_FILE, "utf8")) as unknown;
    if (Array.isArray(parsed)) entries = parsed.map(parseStoredAuth).filter((value): value is StoredAuth => value !== null);
  } catch {
    // A missing or malformed cache is replaced; tokens are recoverable via auth.
  }
  const next = entries.filter((entry) => entry.ceremonyUrl !== auth.ceremonyUrl);
  next.push(auth);
  const temporary = join(AUTH_DIR, `auth.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
    flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  });
  await rename(temporary, AUTH_FILE);
  await chmod(AUTH_FILE, 0o600);
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Token file must be a regular file.");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Token file permissions must not allow group or other access.");
  }
}

function parseStoredAuth(value: unknown): StoredAuth | null {
  const row = record(value);
  if (
    !row ||
    typeof row.ceremonyUrl !== "string" ||
    typeof row.token !== "string" ||
    typeof row.participantId !== "string" ||
    !UUID.test(row.participantId) ||
    typeof row.participantName !== "string" ||
    !Number.isSafeInteger(row.expiresAt)
  ) return null;
  return row as unknown as StoredAuth;
}

function parseAuthInit(value: unknown): CliAuthInitResponse {
  const row = record(value);
  if (
    !row ||
    typeof row.userCode !== "string" ||
    typeof row.verificationUri !== "string" ||
    typeof row.loginCode !== "string" ||
    !Number.isSafeInteger(row.interval) ||
    Number(row.interval) < 1 ||
    Number(row.interval) > 60 ||
    !Number.isSafeInteger(row.expiresIn) ||
    Number(row.expiresIn) < 1 ||
    Number(row.expiresIn) > 3_600
  ) throw new Error("Device-auth initiation response is invalid.");
  const verification = new URL(row.verificationUri);
  if (verification.protocol !== "https:") throw new Error("Device-auth verification URL must use HTTPS.");
  return row as unknown as CliAuthInitResponse;
}

function parseAuthToken(value: unknown): CliAuthTokenResponse {
  const row = record(value);
  if (
    !row ||
    typeof row.token !== "string" ||
    typeof row.participantId !== "string" ||
    !UUID.test(row.participantId) ||
    typeof row.participantName !== "string" ||
    row.participantName.length < 1 ||
    !Number.isSafeInteger(row.expiresAt)
  ) throw new Error("Device-auth token response is invalid.");
  return row as unknown as CliAuthTokenResponse;
}

function decodeCanonicalJson(value: string, label: string): unknown {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error(`${label} is not canonical base64url.`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function validAudience(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 ||
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function deviceAuthEndpoint(raw: string): URL {
  const base = new URL(raw);
  const local = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.username || base.password || (base.protocol !== "https:" && !local)) {
    throw new Error("Auth URL must use HTTPS without embedded credentials.");
  }
  return new URL("/api/ceremony/auth/cli", base);
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error(`Auth server returned an empty response (${response.status}).`);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of Readable.fromWeb(response.body as never)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.byteLength;
    if (length > 1_048_576) throw new Error("Auth server JSON response is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error(`Auth server returned invalid JSON (${response.status}).`);
  }
}

function authResponseError(prefix: string, response: Response, value: unknown): Error {
  const row = record(value);
  const detail = typeof row?.error === "string" && row.error.length <= 512 ? `: ${row.error}` : "";
  return new Error(`${prefix} (${response.status})${detail}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (platform === "win32") {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url],
        { stdio: "ignore" },
      );
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    // Opening is best-effort; the URL and user code were already printed.
  }
}
