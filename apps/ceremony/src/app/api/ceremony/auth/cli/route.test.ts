import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  getJson: vi.fn(),
  releaseLock: vi.fn(),
  setJson: vi.fn(),
  takeJson: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  loadAuthEnv: () => ({
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
  }),
}));

vi.mock("@/lib/kv-store", () => mocks);

vi.mock("@/lib/cli-auth", () => ({
  cliLoginKey: (code: string) => `cli-login:${code}`,
}));

vi.mock("@/lib/participant-identity", () => ({
  deriveParticipant: vi.fn(),
  signParticipantToken: vi.fn(),
}));

import { GET, POST } from "./route";

describe("CLI device auth retrieval", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("blocks device auth before accessing services in closed review", async () => {
    vi.stubEnv("CEREMONY_MODE", "rehearsal");
    vi.stubEnv("REHEARSAL_REVIEW_MODE", "true");
    expect((await POST(new NextRequest("https://ceremony.example/api/ceremony/auth/cli", { method: "POST" }))).status).toBe(423);
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    expect(mocks.getJson).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(true);
    mocks.releaseLock.mockResolvedValue(undefined);
  });

  it("initiates the device flow for an empty POST even when it carries a body stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      device_code: "github-device-code", user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.setJson.mockResolvedValue(undefined);
    try {
      const response = await POST(new NextRequest("https://ceremony.example/api/ceremony/auth/cli", {
        method: "POST", headers: { "content-length": "0" }, body: new ReadableStream({ start: (c) => c.close() }), duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ userCode: "ABCD-1234" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("atomically consumes a completed bearer from a no-store POST body", async () => {
    const completed = {
      deviceCode: "github-device-code",
      interval: 5,
      createdAt: Date.now() - 10_000,
      completedToken: "one-time-bearer",
      completedParticipantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
      completedParticipantName: "participant",
      completedExpiresAt: 4_000_000_000,
    };
    mocks.getJson.mockResolvedValue(completed);
    mocks.takeJson.mockResolvedValue(completed);

    const loginCode = "ab".repeat(16);
    const response = await POST(new NextRequest(
      "https://ceremony.example/api/ceremony/auth/cli?ignored=query",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginCode }),
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      token: "one-time-bearer",
      participantId: completed.completedParticipantId,
    });
    expect(mocks.takeJson).toHaveBeenCalledWith(`cli-login:${loginCode}`);
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it("rejects replayable GET retrieval and marks the error no-store", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
