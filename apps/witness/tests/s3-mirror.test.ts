import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3MirrorArchive } from "../src/s3-mirror.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const config = { bucket: "independent-archive", publicBaseUrl: "https://mirror.example", retentionUntil: "2099-01-01T00:00:00.000Z", artifactOrigins: ["https://artifacts.example"] };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const objects = new Map<string, Buffer>(); let lock = true, lostPutResponse = false;
  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const key = command.input.Key as string;
    switch (command.constructor.name) {
      case "GetBucketVersioningCommand": return { Status: "Enabled" };
      case "GetObjectLockConfigurationCommand": return { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } };
      case "PutObjectCommand": {
        expect(command.input.IfNoneMatch).toBe("*"); expect(command.input.ObjectLockMode).toBe("COMPLIANCE");
        if (objects.has(key)) throw new Error("precondition failed");
        const chunks: Buffer[] = [];
        const body = command.input.Body;
        if (Buffer.isBuffer(body)) chunks.push(body); else for await (const chunk of body as Readable) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        expect(command.input.ChecksumSHA256).toBe(Buffer.from(hash(bytes), "hex").toString("base64"));
        objects.set(key, bytes);
        if (lostPutResponse) throw new Error("lost response");
        return { VersionId: "v1" };
      }
      case "GetObjectCommand": {
        const bytes = objects.get(key); if (!bytes) throw Object.assign(new Error(), { name: "NoSuchKey" });
        return { VersionId: "v1", Body: Readable.from([bytes]), ObjectLockMode: lock ? "COMPLIANCE" : undefined, ObjectLockRetainUntilDate: new Date(config.retentionUntil) };
      }
      default: throw new Error("unexpected operation");
    }
  });
  const mirror = new S3MirrorArchive({ send } as unknown as S3Client, config);
  return { mirror, objects, send, unlock: () => { lock = false; }, loseResponse: () => { lostPutResponse = true; } };
}
describe("independent S3 retention mirror", () => {
  it("checks immutable bytes after ambiguous writes and refuses conflicts", async () => {
    const f = fixture(); await f.mirror.ready(); f.loseResponse();
    const bytes = Buffer.from("evidence"); const key = "evidence/witness/id/0/ack.json";
    expect(await f.mirror.put(key, bytes)).toMatchObject({ sha256: hash(bytes), versionId: "v1" });
    expect(await f.mirror.read(key)).toEqual(bytes);
    await expect(f.mirror.put(key, Buffer.from("forkxxxx"))).rejects.toThrow(/conflicted/);
    f.unlock(); await expect(f.mirror.read(key)).rejects.toThrow(/retention/);
  });
  it("downloads only allowlisted artifacts and hashes bytes before retaining them", async () => {
    const f = fixture(), bytes = Buffer.from("public artifact");
    const fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetcher);
    const artifact = { sha256: hash(bytes), byteLength: bytes.length, urls: ["https://artifacts.example/exact"] };
    await f.mirror.mirror(artifact);
    expect(f.objects.get(`artifacts/sha256/${artifact.sha256}`)).toEqual(bytes);
    await f.mirror.mirror(artifact); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(f.mirror.mirror({ ...artifact, sha256: "0".repeat(64) })).rejects.toThrow(/digest/);
    await expect(f.mirror.mirror({ ...artifact, sha256: "1".repeat(64), urls: ["https://unapproved.example/object"] })).rejects.toThrow(/allowlisted/);
    expect(fetcher.mock.calls.length).toBe(2);
  });
});
