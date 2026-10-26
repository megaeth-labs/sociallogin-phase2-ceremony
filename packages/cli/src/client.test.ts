import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CeremonyClient, parseCoordinatorTarget } from "./client.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("v1 coordinator client", () => {
  it("uses authenticated v1 queue and submit contracts with unprefixed hashes", async () => {
    const observed: Array<{ url: string; idempotency: string | undefined; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : null;
        observed.push({
          url: request.url ?? "",
          idempotency: Array.isArray(request.headers["idempotency-key"])
            ? request.headers["idempotency-key"][0]
            : request.headers["idempotency-key"],
          body,
        });
        if (request.headers.authorization !== "Bearer participant-token") {
          json(response, 401, { error: "missing bearer" });
          return;
        }
        if (request.url === "/v1/ceremonies/moss-test/queue") {
          json(response, 201, { ticketId: "ticket-1", status: "QUEUED", position: 2, offer: null });
          return;
        }
        if (request.url === "/v1/leases/lease-1/submit") {
          json(response, 202, { submissionId: "submission-1", state: "SUBMITTED" });
          return;
        }
        if (request.url === "/v1/leases/lease-1") {
          json(response, 200, {
            leaseId: "lease-1",
            state: "VERIFYING",
            submissionId: "submission-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            baseGeneration: 0,
            expectedContributionName: "moss-participant",
            predecessor: {
              sha256: "11".repeat(32),
              byteLength: 100,
              downloadUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/artifact`,
            },
          });
          return;
        }
        if (request.url === "/v1/ceremonies/moss-test/me/state") {
          json(response, 200, {
            ceremonyId: "ceremony-1",
            participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
            queue: null,
            lease: {
              leaseId: "lease-1",
              state: "VERIFYING",
              submissionId: "submission-1",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              baseGeneration: 0,
              expectedContributionName: "moss-participant",
              predecessor: {
                sha256: "11".repeat(32),
                byteLength: 100,
                downloadUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/artifact`,
              },
            },
            submission: {
              submissionId: "submission-1",
              state: "ACCEPTED",
              receiptId: "receipt-1",
            },
          });
          return;
        }
        if (request.url === "/v1/uploads/upload-1") {
          json(response, 200, {
            uploadId: "upload-1",
            state: "COMPLETED",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            artifact: { sha256: "33".repeat(32), byteLength: 123 },
          });
          return;
        }
        response.writeHead(404).end();
      });
    });
    await listen(server);
    cleanup.push(() => close(server));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    const client = new CeremonyClient(
      parseCoordinatorTarget(`http://127.0.0.1:${address.port}`, "moss-test"),
      "participant-token",
    );

    await expect(client.joinQueue("cli-queue:1234567890")).resolves.toMatchObject({ status: "QUEUED" });
    await expect(client.submit("lease-1", {
      uploadId: "upload-1",
      predecessorSha256: "11".repeat(32),
      contributionHashBlake2b512: "22".repeat(64),
    }, "cli-submit:1234567890")).resolves.toMatchObject({ state: "SUBMITTED" });
    await expect(client.getLease("lease-1")).resolves.toMatchObject({
      state: "VERIFYING",
      submissionId: "submission-1",
    });
    await expect(client.getMyState()).resolves.toMatchObject({
      ceremonyId: "ceremony-1",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
      lease: { leaseId: "lease-1" },
      submission: { receiptId: "receipt-1" },
    });
    await expect(client.getUpload("upload-1")).resolves.toMatchObject({
      state: "COMPLETED",
      artifact: { sha256: "33".repeat(32), byteLength: 123 },
    });

    expect(observed).toHaveLength(5);
    expect(observed[0]).toMatchObject({
      url: "/v1/ceremonies/moss-test/queue",
      idempotency: "cli-queue:1234567890",
    });
    expect(observed[1]).toMatchObject({
      url: "/v1/leases/lease-1/submit",
      idempotency: "cli-submit:1234567890",
      body: {
        uploadId: "upload-1",
        predecessorSha256: "11".repeat(32),
        contributionHashBlake2b512: "22".repeat(64),
        clientKind: "cli",
      },
    });
  });

  it("streams a local-proxy upload and verifies coordinator hash/length responses", async () => {
    const payload = Buffer.alloc(256 * 1024, 0x5a);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const directory = await mkdtemp(join(tmpdir(), "moss-cli-upload-"));
    const candidate = join(directory, "candidate.zkey");
    await writeFile(candidate, payload);
    const received: Buffer[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/uploads/upload-1") {
        json(response, 200, {
          uploadId: "upload-1",
          state: "INITIATED",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return;
      }
      if (request.method === "PUT" && request.url === "/v1/uploads/upload-1/content") {
        request.on("data", (chunk) => received.push(Buffer.from(chunk)));
        request.on("end", () => json(response, 200, {
          uploadId: "upload-1", state: "UPLOADING", byteLength: payload.byteLength, sha256,
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/uploads/upload-1/complete") {
        json(response, 200, {
          uploadId: "upload-1", state: "COMPLETED", artifact: { byteLength: payload.byteLength, sha256 },
        });
        return;
      }
      response.writeHead(404).end();
    });
    await listen(server);
    cleanup.push(() => close(server), () => rm(directory, { recursive: true, force: true }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    const target = parseCoordinatorTarget(`http://127.0.0.1:${address.port}`, "moss-test");
    const client = new CeremonyClient(target, "not-logged-or-parsed-here");
    const result = await client.uploadCandidate({
      grant: {
        uploadId: "upload-1", objectKey: "quarantine/candidate.zkey",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), method: "local-proxy",
      },
      path: candidate,
      sha256,
      byteLength: payload.byteLength,
    });
    expect(result).toEqual({});
    expect(Buffer.concat(received)).toEqual(payload);
    await expect(client.completeUpload("upload-1", { sha256, byteLength: payload.byteLength }))
      .resolves.toMatchObject({ state: "COMPLETED" });
  });

  it.each(["UPLOADING", "COMPLETED"])(
    "does not upload candidate bytes again when durable state is %s",
    async (durableState) => {
      const payload = Buffer.alloc(1_024, 0x5a);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const directory = await mkdtemp(join(tmpdir(), "moss-cli-upload-"));
      const candidate = join(directory, "candidate.zkey");
      await writeFile(candidate, payload);
      let putRequests = 0;
      const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/v1/uploads/upload-1") {
          json(response, 200, {
            uploadId: "upload-1",
            state: durableState,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            artifact: { sha256, byteLength: payload.byteLength },
          });
          return;
        }
        if (request.method === "PUT") putRequests += 1;
        response.writeHead(404).end();
      });
      await listen(server);
      cleanup.push(() => close(server), () => rm(directory, { recursive: true, force: true }));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server port");
      const client = new CeremonyClient(
        parseCoordinatorTarget(`http://127.0.0.1:${address.port}`, "moss-test"),
        "not-logged-or-parsed-here",
      );

      await expect(client.uploadCandidate({
        grant: {
          uploadId: "upload-1",
          objectKey: "quarantine/candidate.zkey",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          method: "local-proxy",
        },
        path: candidate,
        sha256,
        byteLength: payload.byteLength,
      })).resolves.toEqual({});
      expect(putRequests).toBe(0);
    },
  );

  it("requires HTTPS away from local development", () => {
    expect(() => parseCoordinatorTarget("http://ceremony.example", "moss-test"))
      .toThrow("must use HTTPS");
    expect(parseCoordinatorTarget("https://ceremony.example/v1/ceremonies/moss-test").slug)
      .toBe("moss-test");
  });
});

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
