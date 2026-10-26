import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getParticipant: vi.fn(),
  signParticipantToken: vi.fn(),
}));

vi.mock("@/lib/participant-auth", () => ({
  getParticipant: mocks.getParticipant,
}));

vi.mock("@/lib/participant-identity", () => ({
  signParticipantToken: mocks.signParticipantToken,
}));

import { GET } from "./route";

describe("browser participant token exchange", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("does not issue a token or load signing material in closed review", async () => {
    vi.stubEnv("CEREMONY_MODE", "rehearsal");
    vi.stubEnv("REHEARSAL_REVIEW_MODE", "true");
    expect((await GET()).status).toBe(423);
    expect(mocks.getParticipant).not.toHaveBeenCalled();
    expect(mocks.signParticipantToken).not.toHaveBeenCalled();
  });

  it("marks the issued bearer response no-store", async () => {
    mocks.getParticipant.mockResolvedValue({
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
      participantName: "participant",
      authSubjectHash: "aa".repeat(32),
    });
    mocks.signParticipantToken.mockResolvedValue({
      token: "browser-bearer",
      expiresAt: 4_000_000_000,
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toMatchObject({
      token: "browser-bearer",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
    });
  });

  it("marks authentication errors no-store", async () => {
    mocks.getParticipant.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
