export interface MultipartPart { partNumber: number; etag: string }
export interface PartGrant { partNumber: number; url: string; headers?: Record<string, string> }
// Small parts give a slow or flaky connection cheap retries and early progress.
const PART_BYTES = 16 * 1024 * 1024;

interface PartResponse { ok: boolean; status: number; etag: string | null }
type PartSender = (input: { url: URL; body: Blob; headers: Headers; signal: AbortSignal; onBytes: (loaded: number) => void }) => Promise<PartResponse>;

/** fetch reports no upload progress: the part counts only once it completes. */
function fetchSender(fetcher: typeof fetch): PartSender {
  return async ({ url, body, headers, signal }) => {
    const response = await fetcher(url, { method: "PUT", body, headers, credentials: "omit", redirect: "error", cache: "no-store", signal });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, etag: response.headers.get("etag") };
  };
}

/** XMLHttpRequest is the browser API that reports upload bytes as they are sent. */
const xhrSender: PartSender = ({ url, body, headers, signal, onBytes }) => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  const abort = () => request.abort();
  const done = () => signal.removeEventListener("abort", abort);
  request.open("PUT", url.toString());
  request.withCredentials = false;
  headers.forEach((value, name) => request.setRequestHeader(name, value));
  request.upload.onprogress = (event) => onBytes(event.loaded);
  request.onload = () => {
    done();
    // XMLHttpRequest follows redirects; a signed part URL never redirects.
    if (request.responseURL && new URL(request.responseURL).href !== url.href) {
      reject(new Error("Upload was redirected."));
      return;
    }
    resolve({ ok: request.status >= 200 && request.status < 300, status: request.status, etag: request.getResponseHeader("etag") });
  };
  request.onerror = () => { done(); reject(new Error("Upload network error.")); };
  request.onabort = () => { done(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
  signal.addEventListener("abort", abort, { once: true });
  request.send(body);
});

/** ETags coordinate S3 completion only; coordinator independently hashes bytes. */
export function parseMultipartParts(value: unknown): MultipartPart[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) throw new Error("Invalid multipart completion list.");
  return value.map((part, index) => {
    if (!part || part.partNumber !== index + 1 || typeof part.etag !== "string" || !part.etag.length || part.etag.length > 256 || /[\r\n]/.test(part.etag)) throw new Error("Invalid multipart completion entry.");
    return { partNumber: part.partNumber, etag: part.etag };
  });
}

export async function uploadBrowserParts(input: {
  payload: Blob;
  expiresAt: string;
  allowedOrigins: readonly string[];
  requestPart(partNumber: number): Promise<{ parts: PartGrant[] }>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<MultipartPart[]> {
  const count = Math.ceil(input.payload.size / PART_BYTES);
  if (count < 1 || count > 10_000) throw new Error("Invalid multipart candidate size.");
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error("Invalid multipart expiry.");
  const send = input.fetcher ? fetchSender(input.fetcher)
    : typeof XMLHttpRequest !== "undefined" ? xhrSender : fetchSender(fetch);
  const completed: MultipartPart[] = [];
  for (let partNumber = 1; partNumber <= count; partNumber++) {
    const before = (partNumber - 1) * PART_BYTES;
    let etag: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal?.throwIfAborted();
      const remaining = expiry - Date.now();
      if (remaining <= 0) throw new Error("Contribution slot expired during upload.");
      const { parts } = await input.requestPart(partNumber);
      if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.partNumber !== partNumber) throw new Error("Coordinator returned an unexpected multipart grant.");
      const grant = parts[0];
      const url = new URL(grant.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || !input.allowedOrigins.includes(url.origin)) throw new Error("Multipart destination is outside the release allowlist.");
      const headers = new Headers();
      for (const [name, value] of Object.entries(grant.headers ?? {})) {
        if (!/^(content-type|x-amz-checksum-sha256)$/i.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw new Error("Unsupported signed upload header.");
        headers.set(name, value);
      }
      let response: PartResponse;
      try {
        const timeout = AbortSignal.timeout(Math.min(remaining, 5 * 60_000));
        response = await send({ url, body: input.payload.slice(before, partNumber * PART_BYTES), headers,
          signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
          onBytes: (loaded) => input.onProgress?.(Math.min(before + loaded, input.payload.size), input.payload.size) });
      } catch {
        input.signal?.throwIfAborted();
        if (attempt === 2) throw new Error("Upload interrupted. Keep this browser's saved contribution to retry.");
        continue;
      }
      if (!response.ok) {
        if (attempt < 2 && (response.status >= 500 || response.status === 403 || response.status === 429)) continue;
        throw new Error(`Multipart upload failed (HTTP ${response.status}).`);
      }
      etag = response.etag ?? undefined;
      if (!etag || etag.length > 256 || /[\r\n]/.test(etag)) throw new Error("Upload response has no valid ETag. Check bucket CORS exposure.");
      break;
    }
    if (!etag) throw new Error("Multipart upload failed.");
    completed.push({ partNumber, etag });
    input.onProgress?.(Math.min(partNumber * PART_BYTES, input.payload.size), input.payload.size);
  }
  return completed;
}
