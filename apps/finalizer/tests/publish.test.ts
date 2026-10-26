import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeBaseUrl, publishFinalization } from "../src/publish/publish.js";
import {
  ConditionalWriteConflict,
  type PublicationStore,
  type PublishOptions,
} from "../src/publish/types.js";

const MIB = 1024 * 1024;
const CEREMONY_ID = "789a742d-af60-44d7-86b6-19182f666a80";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Version { versionId: string; bytes: Buffer; sha256?: string; deleteMarker?: boolean }

class FakeStore implements PublicationStore {
  readonly objects = new Map<string, Version[]>();
  readonly uploads = new Map<string, { key: string; sha256: string; parts: Map<number, Buffer> }>();
  readonly aborted: string[] = [];
  writes = 0;
  crashAfterWrites: number | undefined;
  commitThenThrowOnComplete = false;
  private nextId = 1;

  private write(): void {
    if (this.crashAfterWrites !== undefined && this.writes >= this.crashAfterWrites) {
      throw new Error("simulated crash");
    }
    this.writes += 1;
  }

  seed(key: string, bytes: Buffer, recordedSha256: string): void {
    this.objects.set(key, [{ versionId: `seed-${this.nextId++}`, bytes, sha256: recordedSha256 }]);
  }

  async listVersions(key: string) {
    return (this.objects.get(key) ?? []).map((version) => ({
      versionId: version.versionId, deleteMarker: version.deleteMarker === true, byteLength: version.bytes.byteLength,
    }));
  }

  async headVersion(key: string, versionId: string) {
    const version = this.objects.get(key)?.find((item) => item.versionId === versionId && !item.deleteMarker);
    return version ? { versionId, byteLength: version.bytes.byteLength, ...(version.sha256 ? { sha256: version.sha256 } : {}) } : null;
  }

  async putObject(input: Parameters<PublicationStore["putObject"]>[0]) {
    this.write();
    if (sha256(input.body) !== input.sha256) throw new Error("checksum mismatch");
    return { versionId: this.commit(input.key, Buffer.from(input.body), input.sha256) };
  }

  async createMultipart(input: Parameters<PublicationStore["createMultipart"]>[0]) {
    this.write();
    const uploadId = `upload-${this.nextId++}`;
    this.uploads.set(uploadId, { key: input.key, sha256: input.sha256, parts: new Map() });
    return { uploadId };
  }

  async uploadPart(input: Parameters<PublicationStore["uploadPart"]>[0]) {
    this.write();
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.key) throw new Error("NoSuchUpload");
    if (sha256(input.body) !== input.sha256) throw new Error("part checksum mismatch");
    upload.parts.set(input.partNumber, Buffer.from(input.body));
    return { etag: `"${input.sha256.slice(0, 16)}"` };
  }

  async completeMultipart(input: Parameters<PublicationStore["completeMultipart"]>[0]) {
    this.write();
    const upload = this.uploads.get(input.uploadId);
    if (!upload) throw new Error("NoSuchUpload");
    const body = Buffer.concat(input.parts.map((part) => upload.parts.get(part.partNumber)!));
    this.uploads.delete(input.uploadId);
    const versionId = this.commit(input.key, body, upload.sha256);
    if (this.commitThenThrowOnComplete) {
      this.commitThenThrowOnComplete = false;
      throw new Error("connection reset after completion");
    }
    return { versionId };
  }

  async abortMultipart(input: { key: string; uploadId: string }) {
    // A crashed process never gets to abort; the next run must.
    if (this.crashAfterWrites !== undefined && this.writes >= this.crashAfterWrites) throw new Error("simulated crash");
    this.aborted.push(input.uploadId);
    this.uploads.delete(input.uploadId);
  }

  private commit(key: string, bytes: Buffer, recorded: string): string {
    if ((this.objects.get(key) ?? []).length > 0) throw new ConditionalWriteConflict();
    const versionId = `v-${this.nextId++}`;
    this.objects.set(key, [{ versionId, bytes, sha256: recorded }]);
    return versionId;
  }
}

/** Serves the fake store over loopback HTTP, the way CloudFront serves the bucket. */
function serve(store: FakeStore, tamper: Set<string>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.slice(1));
    const version = store.objects.get(key)?.find((item) => item.versionId === url.searchParams.get("versionId"));
    if (!version) {
      response.writeHead(404).end();
      return;
    }
    const bytes = Buffer.from(version.bytes);
    if (tamper.has(key)) bytes[0] ^= 0xff;
    response.writeHead(200, { "content-length": bytes.byteLength }).end(bytes);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
    });
  });
}

async function writeFinalizerOutput(directory: string): Promise<Record<string, Buffer>> {
  await mkdir(directory);
  const files: Record<string, Buffer> = {
    "final.zkey": randomBytes(Math.floor(2.5 * MIB)),
    "sealed-import.zkey": randomBytes(Math.floor(1.2 * MIB)),
    "verification_key.json": Buffer.from('{"protocol":"groth16","nPublic":20}'),
    "Verifier.sol": Buffer.from("contract Groth16Verifier {}\n"),
    "ethereum-block-evidence.json": Buffer.from('{"blockNumber":1}'),
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  const ref = (fileName: string) => ({ fileName, sha256: sha256(files[fileName]), byteLength: files[fileName].byteLength });
  const summary = {
    schemaVersion: 1,
    type: "moss.phase2.final-artifacts.v1",
    ceremonyId: CEREMONY_ID,
    outputs: {
      importedSealedZkey: ref("sealed-import.zkey"),
      finalZkey: ref("final.zkey"),
      verificationKey: { ...ref("verification_key.json"), publicInputCount: 20 },
      solidityVerifier: ref("Verifier.sol"),
      beaconEvidence: ref("ethereum-block-evidence.json"),
    },
  };
  files["final-artifacts.json"] = Buffer.from(JSON.stringify(summary));
  await writeFile(join(directory, "final-artifacts.json"), files["final-artifacts.json"]);
  return files;
}

describe("final artifact publication", () => {
  let workspace: string;
  let outputDir: string;
  let files: Record<string, Buffer>;
  let store: FakeStore;
  let tamper: Set<string>;
  let server: Server;
  let baseUrl: string;
  let caseIndex = 0;
  let journalPath: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "moss-publish-test-"));
    outputDir = join(workspace, "finalized");
    files = await writeFinalizerOutput(outputDir);
  });
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  beforeEach(async () => {
    store = new FakeStore();
    tamper = new Set();
    ({ server, baseUrl } = await serve(store, tamper));
    journalPath = join(workspace, `journal-${caseIndex++}.json`);
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const options = (extra: Partial<PublishOptions> = {}): PublishOptions => ({
    finalizerOutputDir: outputDir,
    label: "2026-11-02",
    publicBaseUrl: baseUrl,
    journalPath,
    singlePutMaxBytes: MIB,
    partSizeBytes: MIB,
    ...extra,
  });
  const publish = (extra?: Partial<PublishOptions>) => publishFinalization(options(extra), { store });

  it("publishes hash-addressed versions, verifies downloads and reruns to identical bytes", async () => {
    const indexOut = join(workspace, "index-copy.json");
    const first = await publish({ indexOutPath: indexOut });
    expect(Object.keys(first.artifacts).sort()).toEqual([
      "beaconEvidence", "finalZkey", "finalizerSummary", "importedSealedZkey", "solidityVerifier", "verificationKey",
    ]);
    const finalZkey = first.artifacts.finalZkey;
    expect(finalZkey.objectKey).toBe(`finalization/${CEREMONY_ID}/2026-11-02/sha256/${sha256(files["final.zkey"])}/final.zkey`);
    expect(finalZkey.url).toBe(`${baseUrl}${finalZkey.objectKey}?versionId=${finalZkey.versionId}`);
    expect(first.index.objectKey).toBe(
      `finalization/${CEREMONY_ID}/2026-11-02/sha256/${first.index.sha256}/publication-index.json`,
    );
    const indexBytes = await readFile(indexOut);
    expect(sha256(indexBytes)).toBe(first.index.sha256);
    expect(JSON.parse(indexBytes.toString("utf8")).type).toBe("moss.phase2.final-publication-index.v1");

    const writes = store.writes;
    const second = await publish({ indexOutPath: indexOut });
    expect(second.index).toEqual(first.index);
    expect(store.writes).toBe(writes);
    for (const versions of store.objects.values()) expect(versions).toHaveLength(1);
    expect(JSON.parse(await readFile(journalPath, "utf8")).pendingMultipart).toEqual([]);
  });

  it.each([1, 2, 4, 7, 9, 11])("converges after a crash following %i writes", async (writes) => {
    store.crashAfterWrites = writes;
    await expect(publish()).rejects.toThrow("simulated crash");
    store.crashAfterWrites = undefined;
    const recovered = await publish();
    for (const versions of store.objects.values()) expect(versions).toHaveLength(1);
    expect(store.uploads.size).toBe(0);
    const again = await publish();
    expect(again.index).toEqual(recovered.index);
  });

  it("aborts a multipart upload a crashed run left behind", async () => {
    // create (1) + first part (2), then crash inside the final zkey upload.
    store.crashAfterWrites = 2;
    await expect(publish()).rejects.toThrow("simulated crash");
    const pending = JSON.parse(await readFile(journalPath, "utf8")).pendingMultipart;
    expect(pending).toHaveLength(1);
    store.crashAfterWrites = undefined;
    await publish();
    expect(store.aborted).toContain(pending[0].uploadId);
  });

  it("accepts an ambiguous multipart completion only after reading the version back", async () => {
    store.commitThenThrowOnComplete = true;
    const result = await publish();
    expect(store.objects.get(result.artifacts.finalZkey.objectKey)).toHaveLength(1);
  });

  it("refuses an existing object whose recorded digest differs", async () => {
    const key = `finalization/${CEREMONY_ID}/2026-11-02/sha256/${sha256(files["final.zkey"])}/final.zkey`;
    store.seed(key, randomBytes(16), "0".repeat(64));
    await expect(publish()).rejects.toThrow("differs from the local artifact");
  });

  it("refuses an existing object whose bytes differ from its recorded digest", async () => {
    const bytes = Buffer.from(files["Verifier.sol"]);
    bytes[0] ^= 0xff;
    const key = `finalization/${CEREMONY_ID}/2026-11-02/sha256/${sha256(files["Verifier.sol"])}/Verifier.sol`;
    store.seed(key, Buffer.concat([bytes]), sha256(files["Verifier.sol"]));
    await expect(publish()).rejects.toThrow("Verifier.sol does not hash to its index entry");
  });

  it("refuses a key holding a second version", async () => {
    const key = `finalization/${CEREMONY_ID}/2026-11-02/sha256/${sha256(files["Verifier.sol"])}/Verifier.sol`;
    store.seed(key, files["Verifier.sol"], sha256(files["Verifier.sol"]));
    store.objects.get(key)!.push({ versionId: "extra", bytes: files["Verifier.sol"], sha256: sha256(files["Verifier.sol"]) });
    await expect(publish()).rejects.toThrow("has 2 versions");
  });

  it("fails when a published download does not hash to the index", async () => {
    const key = `finalization/${CEREMONY_ID}/2026-11-02/sha256/${sha256(files["final.zkey"])}/final.zkey`;
    tamper.add(key);
    await expect(publish()).rejects.toThrow("final.zkey does not hash to its index entry");
  });

  it("refuses files that differ from the finalizer summary", async () => {
    const directory = join(workspace, `mismatch-${caseIndex}`);
    await writeFinalizerOutput(directory);
    await writeFile(join(directory, "Verifier.sol"), "contract Changed {}\n");
    await expect(publish({ finalizerOutputDir: directory })).rejects.toThrow("Verifier.sol does not match the finalizer summary");
  });

  it("refuses a journal from a different publication", async () => {
    await publish();
    await expect(publish({ label: "2026-11-03" })).rejects.toThrow("different publication (label)");
  });

  it("publishes the audit report and proof evidence bound to the final zkey", async () => {
    const audit = join(workspace, "audit.json");
    const proofs = join(workspace, "proofs.json");
    await writeFile(audit, JSON.stringify({ type: "moss.phase2.ceremony-audit.v1", ceremonyId: CEREMONY_ID }));
    await writeFile(proofs, JSON.stringify({
      type: "moss.phase2.proof-tests.v1",
      finalZkey: { sha256: sha256(files["final.zkey"]), byteLength: files["final.zkey"].byteLength },
    }));
    const result = await publish({ auditReportPath: audit, proofEvidencePath: proofs });
    expect(result.artifacts.auditReport?.fileName).toBe("ceremony-audit.json");
    expect(result.artifacts.proofEvidence?.fileName).toBe("proof-verification-index.json");

    await writeFile(proofs, JSON.stringify({ type: "moss.phase2.proof-tests.v1", finalZkey: { sha256: "1".repeat(64), byteLength: 1 } }));
    await expect(publish({ proofEvidencePath: proofs })).rejects.toThrow("different final zkey");
  });

  it("only serves plain HTTPS public origins, or loopback HTTP for local checks", () => {
    expect(normalizeBaseUrl("https://archive.example/final")).toBe("https://archive.example/final/");
    expect(() => normalizeBaseUrl("http://archive.example/")).toThrow("plain HTTPS origin");
    expect(() => normalizeBaseUrl("https://archive.example/?a=1")).toThrow("plain HTTPS origin");
    expect(() => normalizeBaseUrl("https://user@archive.example/")).toThrow("plain HTTPS origin");
  });
});
