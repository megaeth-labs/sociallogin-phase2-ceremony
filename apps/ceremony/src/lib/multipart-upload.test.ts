import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMultipartParts, uploadBrowserParts } from "./multipart-upload";

const base = () => ({ payload: new Blob(["candidate"]), expiresAt: new Date(Date.now() + 60000).toISOString(),
  allowedOrigins: ["https://quarantine.example"], requestPart: async (partNumber: number) => ({ parts: [{ partNumber, url: "https://quarantine.example/object?signed=capability" }] }) });

describe("browser multipart upload", () => {
  it("retries transient failures with a fresh grant and omits credentials/redirects", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { headers: { etag: '"part-1"' } }));
    const requestPart = vi.fn(base().requestPart);
    expect(await uploadBrowserParts({ ...base(), fetcher, requestPart })).toEqual([{ partNumber: 1, etag: '"part-1"' }]);
    expect(requestPart).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error" });
    expect(await fetcher.mock.calls[1][1].body.text()).toBe("candidate");
  });
  it("fails closed on expiry, cross-origin grants, duplicate parts, missing ETags and unsafe headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null));
    await expect(uploadBrowserParts({ ...base(), expiresAt: "2000-01-01T00:00:00.000Z", fetcher })).rejects.toThrow(/expired/);
    await expect(uploadBrowserParts({ ...base(), allowedOrigins: [], fetcher })).rejects.toThrow(/allowlist/);
    await expect(uploadBrowserParts({ ...base(), fetcher, requestPart: async () => ({ parts: [{ partNumber: 2, url: "https://quarantine.example" }] }) })).rejects.toThrow(/unexpected/);
    await expect(uploadBrowserParts({ ...base(), fetcher, requestPart: async () => ({ parts: [{ partNumber: 1, url: "https://quarantine.example", headers: { Authorization: "forbidden" } }] }) })).rejects.toThrow(/header/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(uploadBrowserParts({ ...base(), fetcher })).rejects.toThrow(/ETag/);
  });
  it("bounds retry attempts and honors cancellation", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network"));
    await expect(uploadBrowserParts({ ...base(), fetcher })).rejects.toThrow(/interrupted/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    await expect(uploadBrowserParts({ ...base(), fetcher, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects malformed completion journals", () => {
    for (const value of [[], [{ partNumber: 2, etag: "x" }], [{ partNumber: 1, etag: "\r\n" }]]) expect(() => parseMultipartParts(value)).toThrow();
  });
});

describe("byte progress through XMLHttpRequest", () => {
  class FakeRequest {
    static sent: { url: string; headers: Record<string, string>; credentials: boolean }[] = [];
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseURL = "";
    withCredentials = true;
    private url = "";
    private headers: Record<string, string> = {};
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    getResponseHeader(name: string) { return name === "etag" ? '"part-1"' : null; }
    abort() { this.onabort?.(); }
    send(body: Blob) {
      FakeRequest.sent.push({ url: this.url, headers: this.headers, credentials: this.withCredentials });
      this.upload.onprogress?.({ loaded: Math.floor(body.size / 2) });
      this.upload.onprogress?.({ loaded: body.size });
      this.status = 200;
      this.responseURL = this.url;
      this.onload?.();
    }
  }
  afterEach(() => { vi.unstubAllGlobals(); FakeRequest.sent = []; });

  it("reports bytes as they are sent and returns the part's ETag", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const progress: number[] = [];
    const parts = await uploadBrowserParts({ ...base(), onProgress: (uploaded) => progress.push(uploaded) });
    expect(parts).toEqual([{ partNumber: 1, etag: '"part-1"' }]);
    // Mid-part progress, then the completed total (reported again as the part completes).
    expect(progress[0]).toBe(4);
    expect(progress.at(-1)).toBe(9);
    expect(FakeRequest.sent[0]).toMatchObject({ credentials: false });
  });
});
