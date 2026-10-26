import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { getParticipant } from "@/lib/participant-auth";
import { authorizeBadge, loadBadge } from "@/lib/nft/server";
vi.mock("@/lib/participant-auth", () => ({ getParticipant: vi.fn() }));
vi.mock("@/lib/nft/server", async (original) => ({
  ...(await original<typeof import("@/lib/nft/server")>()),
  authorizeBadge: vi.fn(),
  loadBadge: vi.fn(),
}));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipient = `0x${"1".repeat(40)}`;
const participant = {
  participantId: id,
  participantName: "Alice",
  authSubjectHash: "test",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://ceremony.example");
  vi.mocked(getParticipant).mockResolvedValue(participant);
});
afterEach(() => vi.unstubAllEnvs());
const request = (
  body: unknown = { receiptId: id, recipient },
  origin = "https://ceremony.example",
) =>
  new Request("https://ceremony.example/api/ceremony/nft", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
it("requires authentication for status and claims", async () => {
  vi.mocked(getParticipant).mockResolvedValue(null);
  expect(
    (
      await GET(
        new Request(
          `https://ceremony.example/api/ceremony/nft?receiptId=${id}`,
        ),
      )
    ).status,
  ).toBe(401);
  expect((await POST(request())).status).toBe(401);
  expect(authorizeBadge).not.toHaveBeenCalled();
});
it("rejects cross-origin claims and client-supplied receipt evidence", async () => {
  expect((await POST(request(undefined, "https://evil.example"))).status).toBe(
    403,
  );
  expect(
    (await POST(request({ receiptId: id, recipient, accepted: true }))).status,
  ).toBe(400);
  expect(authorizeBadge).not.toHaveBeenCalled();
});
it("returns private non-cacheable status and generic server failures", async () => {
  vi.mocked(loadBadge).mockResolvedValue(null);
  const response = await GET(
    new Request(`https://ceremony.example/api/ceremony/nft?receiptId=${id}`),
  );
  expect(await response.json()).toEqual({ enabled: false });
  expect(response.headers.get("cache-control")).toContain("no-store");
  vi.mocked(authorizeBadge).mockRejectedValue(
    new Error("private provider diagnostic"),
  );
  const failure = await POST(request());
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("private provider diagnostic");
});
it("validates identifiers and size before authorizing", async () => {
  expect(
    (await POST(request({ receiptId: "../other", recipient }))).status,
  ).toBe(400);
  expect(
    (await POST(request({ receiptId: id, recipient: "x".repeat(2100) })))
      .status,
  ).toBe(413);
  expect(authorizeBadge).not.toHaveBeenCalled();
});
