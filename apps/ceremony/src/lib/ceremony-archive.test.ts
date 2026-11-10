// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import archive from "../../public/ceremony-archive.json";
import { ceremonyArchive } from "./ceremony-archive";
import { loadCoordinatorBootstrap, resetArchivedUpdateCache } from "./coordinator-bootstrap";

const records = new URL("../../../../ceremonies/moss-social-login-phase2/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, records), "utf8");
const rootPem = read("manifest-root.pub");
const rootSpki = createHash("sha256").update(createPublicKey(rootPem).export({ type: "spki", format: "der" })).digest("hex");
// The signed update list as the coordinator served it after update 14.
const updateList = JSON.parse(read("web-updates/2026-11-05-finalization/history-after.json")) as { updates: { payload: { webRelease?: { sourceCommit: string } } }[] };
const update14Release = updateList.updates.at(-1)!.payload.webRelease!;
const SLUG = "moss-social-login-phase2";

function stubArchivedEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CEREMONY_MODE", "production");
  vi.stubEnv("CEREMONY_SLUG", SLUG);
  vi.stubEnv("COORDINATOR_BASE_URL", undefined);
  vi.stubEnv("MANIFEST_ROOT_KEY_ID", "moss-social-login-root-2026-10");
  vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE", undefined);
  vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY", rootPem);
  vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256", rootSpki);
  vi.stubEnv("MOSS_WEB_BUILD_ID", update14Release.sourceCommit);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetArchivedUpdateCache();
});

describe("the bundled mainnet archive", () => {
  it("is the sealed mainnet ceremony, matching the records in this repository", () => {
    const value = ceremonyArchive(SLUG)!;
    expect(value.manifest).toEqual(JSON.parse(read("manifest.signed.json")));
    expect(value.checkpoint).toEqual(JSON.parse(read("sealed-checkpoint.signed.json")));
    expect(value.receipts).toHaveLength(value.checkpoint.payload.generation);
    expect(value.receipts.at(-1)!.payload.successor.sha256).toBe(value.checkpoint.payload.headSha256);
    expect(value.coordinator).toBe("https://dy87eh5gw5.execute-api.us-east-2.amazonaws.com");
    expect(new URL(value.operationalUpdatesUrl).origin).toBe("https://d1xydbco3b83a0.cloudfront.net");
  });

  it("serves only the ceremony it was captured from", () => {
    expect(ceremonyArchive("another-ceremony")).toBeNull();
    expect(ceremonyArchive(undefined)).toBeNull();
  });

  it("refuses a malformed archive rather than serving it", () => {
    expect(() => ceremonyArchive(SLUG, { ...archive, receipts: undefined })).toThrow(/malformed/);
    expect(() => ceremonyArchive(SLUG, { ...archive, ceremonyId: "other" })).toThrow(/malformed/);
    expect(() => ceremonyArchive(SLUG, { ...archive, operationalUpdatesUrl: `${archive.operationalUpdatesUrl}?versionId=x` })).toThrow(/plain HTTPS/);
  });
});

describe("archived bootstrap", () => {
  beforeEach(stubArchivedEnv);

  function serve(list: unknown, status = 200) {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe(archive.operationalUpdatesUrl);
      return Response.json(list, { status });
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("verifies the bundled manifest and the archived update list, and never asks the coordinator", async () => {
    const fetcher = serve(updateList);
    const bootstrap = await loadCoordinatorBootstrap();
    expect(bootstrap.activeWebRelease).toEqual(update14Release);
    expect(bootstrap.archive).toEqual({ checkpoint: archive.checkpoint, receiptsUrl: "/ceremony-archive.json" });
    expect(bootstrap.manifest).toEqual(archive.manifest);
    expect(bootstrap.rootSpkiSha256).toBe(rootSpki);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a build no signed update authorizes", async () => {
    serve(updateList);
    vi.stubEnv("MOSS_WEB_BUILD_ID", "f".repeat(40));
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/not been authorized/);
  });

  it("refuses a tampered update list and a manifest under another root key", async () => {
    const tampered = structuredClone(updateList);
    (tampered.updates.at(-1)!.payload as { reason?: string }).reason = "tampered";
    serve(tampered);
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/signature/);
    serve(updateList);
    vi.stubEnv("MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256", "0".repeat(64));
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/release pin/);
  });

  it("keeps the last verified list when the archive is unreachable or serves a bad one, and fails closed without one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(loadCoordinatorBootstrap()).rejects.toThrow("Operational update history is unavailable.");
    serve(updateList, 503);
    await expect(loadCoordinatorBootstrap()).rejects.toThrow(/unavailable \(503\)/);

    serve(updateList);
    await loadCoordinatorBootstrap();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(update14Release);
      // Valid signatures, but shorter: not a newer history, so the verified one stays.
      serve({ updates: updateList.updates.slice(0, 13) });
      expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(update14Release);
      const tampered = structuredClone(updateList);
      (tampered.updates.at(-1)!.payload as { reason?: string }).reason = "tampered";
      serve(tampered);
      expect((await loadCoordinatorBootstrap()).activeWebRelease).toEqual(update14Release);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("archived status and history in the browser", () => {
  beforeEach(() => vi.resetModules());

  async function browserApi() {
    stubArchivedEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(updateList)));
    const bootstrap = await loadCoordinatorBootstrap();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(String(url));
      if (url === "/api/ceremony/bootstrap") return Response.json(JSON.parse(JSON.stringify(bootstrap)));
      if (url === "/ceremony-archive.json") return Response.json(archive);
      return new Response("unexpected request", { status: 599 });
    }));
    return { api: await import("./api"), requests };
  }

  it("shows the finalized ceremony from the sealed checkpoint after its expiry, without the coordinator", async () => {
    const { api, requests } = await browserApi();
    expect(Date.parse(archive.checkpoint.payload.expiresAt)).toBeLessThan(Date.now());
    const status = await api.getStatus();
    expect(status).toMatchObject({ ceremonyState: "SEALED", isActive: false, totalContributions: 357, headByteLength: 368_577_436 });
    expect(status.circuits[0]!.queueLength).toBe(0);
    expect(status.finalization?.ceremonyId).toBe(archive.ceremonyId);
    expect(await api.isCeremonyArchived()).toBe(true);
    expect(requests).toEqual(["/api/ceremony/bootstrap"]);
  });

  it("checks every receipt and the whole chain once, then pages it newest first with archive downloads", async () => {
    const { api, requests } = await browserApi();
    const first = await api.getContributionHistoryPage(0);
    expect(first.total).toBe(357);
    expect(first.items.map((item) => item.receipt.generation)).toEqual([357, 356, 355, 354, 353]);
    expect(first.items[0]!.artifactDownloadUrl).toBe(archive.receipts[356]!.payload.successor.urls[0]);
    expect(new URL(first.items[0]!.artifactDownloadUrl!).origin).toBe("https://d1xydbco3b83a0.cloudfront.net");
    const last = await api.getContributionHistoryPage(71);
    expect(last.items.map((item) => item.receipt.generation)).toEqual([2, 1]);
    expect(requests.filter((url) => url === "/ceremony-archive.json")).toHaveLength(1);
  }, 30_000);

  it("refuses an archive with a missing or reordered receipt", async () => {
    const { api } = await browserApi();
    expect(await api.isCeremonyArchived()).toBe(true);
    const receipts = [...archive.receipts];
    [receipts[10], receipts[11]] = [receipts[11]!, receipts[10]!];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ receipts })));
    await expect(api.getContributionHistoryPage(0)).rejects.toThrow(/gap or a broken artifact chain/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ receipts: archive.receipts.slice(1) })));
    await expect(api.getContributionHistoryPage(0)).rejects.toThrow(/every accepted contribution/);
  }, 30_000);
});

describe("participant routes once archived", () => {
  it("answer 410 Gone for this ceremony and stay live for any other", async () => {
    const { closedForArchive } = await import("./archived-routes");
    vi.stubEnv("CEREMONY_SLUG", SLUG);
    const closed = closedForArchive()!;
    expect(closed.status).toBe(410);
    expect(await closed.json()).toEqual({ error: "The ceremony is complete and contributions are closed." });
    vi.stubEnv("CEREMONY_SLUG", "another-ceremony");
    expect(closedForArchive()).toBeNull();
    vi.stubEnv("CEREMONY_SLUG", SLUG);
    const token = await import("@/app/api/ceremony/auth/token/route");
    expect((await token.GET()).status).toBe(410);
  });
});
