import { rehearsalReviewEnabled } from "@/lib/rehearsal-review";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { loadAuthEnv } from "@/lib/env";
import {
  acquireLock,
  getJson,
  releaseLock,
  setJson,
  takeJson,
} from "@/lib/kv-store";
import {
  deriveParticipant,
  signParticipantToken,
} from "@/lib/participant-identity";
import { cliLoginKey, type PendingDeviceAuth } from "@/lib/cli-auth";

const LOGIN_TTL_SECONDS = 900;
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const LOGIN_CODE = /^[a-f0-9]{32}$/u;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

/**
 * POST /api/ceremony/auth/cli
 *
 * Initiates the GitHub OAuth device flow (RFC 8628). The server proxies
 * the request so the CLI never needs the client ID or secret.
 * Returns a user code for the participant to enter at github.com/login/device.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (rehearsalReviewEnabled()) {
    return NextResponse.json({ error: "Contributions are closed during rehearsal review." }, { status: 423, headers: NO_STORE_HEADERS });
  }
  // A bodiless POST can still arrive with an empty body stream, so decide by
  // what the client declared rather than by whether request.body is set.
  if (request.headers.has("content-type") || Number(request.headers.get("content-length") ?? "0") > 0) {
    return await pollDeviceFlow(request);
  }

  const env = loadAuthEnv();
  const deviceResponse = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!deviceResponse.ok) {
    return json(
      { error: "Failed to initiate GitHub device flow" },
      { status: 502 },
    );
  }

  const deviceData = (await deviceResponse.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (deviceData.error || !deviceData.device_code || !deviceData.user_code) {
    return json(
      {
        error:
          deviceData.error_description ??
          "GitHub device flow initiation failed. Is the Device Flow enabled in your OAuth App settings?",
      },
      { status: 400 },
    );
  }

  const loginCode = randomBytes(16).toString("hex");

  await setJson(
    cliLoginKey(loginCode),
    {
      deviceCode: deviceData.device_code,
      interval: deviceData.interval ?? 5,
      createdAt: Date.now(),
    } satisfies PendingDeviceAuth,
    LOGIN_TTL_SECONDS,
  );

  return json({
    userCode: deviceData.user_code,
    verificationUri: deviceData.verification_uri,
    loginCode,
    interval: deviceData.interval ?? 5,
    expiresIn: deviceData.expires_in ?? 900,
  });
}

/**
 * POST /api/ceremony/auth/cli with { "loginCode": "..." }
 *
 * Poll endpoint. The CLI calls this at the interval returned by POST.
 * The server checks GitHub's token endpoint with the stored device_code.
 * Returns 202 while pending, or the signed CLI JWT once authorized.
 */
async function pollDeviceFlow(request: NextRequest): Promise<NextResponse> {
  const env = loadAuthEnv();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 1_024) {
    return json({ error: "Poll request is too large" }, { status: 413 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json(
      { error: "Poll request must use application/json" },
      { status: 415 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Poll request is not valid JSON" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("loginCode" in body) ||
    typeof body.loginCode !== "string" ||
    !LOGIN_CODE.test(body.loginCode)
  ) {
    return json(
      { error: "loginCode is required" },
      { status: 400 },
    );
  }
  const code = body.loginCode;

  const pending = await getJson<PendingDeviceAuth>(cliLoginKey(code));
  if (!pending) {
    return json(
      { error: "Invalid or expired login code" },
      { status: 404 },
    );
  }

  const lockKey = `cli-login-lock:${code}`;
  const lockToken = randomBytes(16).toString("hex");
  const locked = await acquireLock(lockKey, lockToken);

  if (!locked) {
    return json(
      { status: "pending", interval: pending.interval },
      { status: 202 },
    );
  }

  try {
    // Re-read after acquiring lock to see updates from a prior holder.
    const fresh = await getJson<PendingDeviceAuth>(cliLoginKey(code));
    if (!fresh) {
      return json(
        { error: "Invalid or expired login code" },
        { status: 404 },
      );
    }

    if (fresh.completedToken) {
      if (!isCompleted(fresh)) {
        return json(
          { error: "Stored login token is malformed" },
          { status: 500 },
        );
      }
      const completed = await takeJson<PendingDeviceAuth>(cliLoginKey(code));
      if (!completed || !isCompleted(completed)) {
        return json(
          { error: "Login token was already retrieved" },
          { status: 409 },
        );
      }
      return completedResponse(completed);
    }

    const now = Date.now();
    const lastPoll = fresh.lastPolledAt ?? fresh.createdAt;
    const elapsedSeconds = (now - lastPoll) / 1000;

    if (elapsedSeconds < fresh.interval) {
      return json(
        { status: "pending", interval: fresh.interval },
        { status: 202 },
      );
    }

    await setJson(
      cliLoginKey(code),
      { ...fresh, lastPolledAt: now } satisfies PendingDeviceAuth,
      LOGIN_TTL_SECONDS,
    );

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        device_code: fresh.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!tokenResponse.ok) {
      return json(
        { error: "GitHub token exchange failed" },
        { status: 502 },
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenData.error === "authorization_pending") {
      return json({ status: "pending" }, { status: 202 });
    }

    if (tokenData.error === "slow_down") {
      const increased = fresh.interval + 5;
      await setJson(
        cliLoginKey(code),
        { ...fresh, interval: increased, lastPolledAt: now } satisfies PendingDeviceAuth,
        LOGIN_TTL_SECONDS,
      );
      return json(
        { status: "pending", interval: increased },
        { status: 202 },
      );
    }

    if (tokenData.error || !tokenData.access_token) {
      return json(
        {
          error:
            tokenData.error_description ??
            tokenData.error ??
            "GitHub authorization failed",
        },
        { status: 400 },
      );
    }

    const userResponse = await fetch(GITHUB_USER_URL, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!userResponse.ok) {
      return json(
        { error: "Failed to fetch GitHub user profile" },
        { status: 502 },
      );
    }

    const user = (await userResponse.json()) as {
      id?: number;
      login?: string;
      name?: string;
    };

    if (!user.id) {
      return json(
        { error: "Invalid GitHub user profile" },
        { status: 502 },
      );
    }

    const participant = await deriveParticipant(
      "github",
      String(user.id),
      user.login ?? user.name ?? `github-user-${user.id}`,
    );
    const { token, expiresAt } = await signParticipantToken(participant, "cli");
    const { participantId, participantName } = participant;

    await setJson(
      cliLoginKey(code),
      {
        ...fresh,
        completedToken: token,
        completedParticipantId: participantId,
        completedParticipantName: participantName,
        completedExpiresAt: expiresAt,
      } satisfies PendingDeviceAuth,
      LOGIN_TTL_SECONDS,
    );

    const completed = await takeJson<PendingDeviceAuth>(cliLoginKey(code));
    if (!completed || !isCompleted(completed)) {
      return json(
        { error: "Login token delivery could not be completed" },
        { status: 503 },
      );
    }
    return completedResponse(completed);
  } finally {
    try {
      await releaseLock(lockKey, lockToken);
    } catch {
      // Lock TTL will expire; don't override the already-computed response.
    }
  }
}

export function GET(): NextResponse {
  return json(
    { error: "Use POST with a JSON request body" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

function completedResponse(completed: PendingDeviceAuth): NextResponse {
  return json({
    token: completed.completedToken,
    participantId: completed.completedParticipantId,
    participantName: completed.completedParticipantName,
    expiresAt: completed.completedExpiresAt,
  });
}

function isCompleted(
  value: PendingDeviceAuth,
): value is PendingDeviceAuth & {
  completedToken: string;
  completedParticipantId: string;
  completedParticipantName: string;
  completedExpiresAt: number;
} {
  return (
    typeof value.completedToken === "string" &&
    value.completedToken.length > 0 &&
    typeof value.completedParticipantId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.completedParticipantId,
    ) &&
    typeof value.completedParticipantName === "string" &&
    value.completedParticipantName.length >= 1 &&
    value.completedParticipantName.length <= 128 &&
    typeof value.completedExpiresAt === "number" &&
    Number.isSafeInteger(value.completedExpiresAt) &&
    value.completedExpiresAt > Math.floor(Date.now() / 1_000)
  );
}

function json(
  body: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): NextResponse {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  return NextResponse.json(body, { ...init, headers });
}
