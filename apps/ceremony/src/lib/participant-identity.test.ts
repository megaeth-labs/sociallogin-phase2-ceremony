import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deriveParticipant,
  signParticipantToken,
} from "./participant-identity";

let workDirectory = "";
let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), "moss-phase2-web-auth-"));
  const keys = generateKeyPairSync("ed25519");
  publicKey = keys.publicKey;
  const privateKeyPath = join(workDirectory, "participant-private.pem");
  const derivationKeyPath = join(workDirectory, "participant-derivation-key");
  await writeFile(
    privateKeyPath,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(
    derivationKeyPath,
    `${randomBytes(32).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  process.env.PARTICIPANT_JWT_PRIVATE_KEY_FILE = privateKeyPath;
  process.env.PARTICIPANT_ID_DERIVATION_KEY_FILE = derivationKeyPath;
  process.env.PARTICIPANT_JWT_ISSUER = "moss-test-auth";
  process.env.PARTICIPANT_JWT_AUDIENCE = "moss-test-coordinator";
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe("participant identity issuer", () => {
  it("derives a stable keyed UUIDv8 without exposing the provider subject", async () => {
    const first = await deriveParticipant("github", "123456", "alice");
    const same = await deriveParticipant("github", "123456", "alice");
    const other = await deriveParticipant("github", "123457", "bob");

    expect(first).toEqual(same);
    expect(first.participantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first.authSubjectHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("123456");
    expect(other.participantId).not.toBe(first.participantId);
  });

  it("issues the strict EdDSA token accepted by the coordinator", async () => {
    const participant = await deriveParticipant("github", "654321", "carol");
    const issued = await signParticipantToken(participant, "browser");
    const [header, payload, signature] = issued.token.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "EdDSA",
      typ: "JWT",
    });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`, "ascii"),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toMatchObject({
      iss: "moss-test-auth",
      aud: "moss-test-coordinator",
      sub: participant.participantId,
      ash: participant.authSubjectHash,
      name: "carol",
    });
  });

  it("preserves account limits when a GitHub username changes", async () => {
    const before = await deriveParticipant("github", "123456", "alice");
    const after = await deriveParticipant("github", "123456", "alice-renamed");
    expect(after.participantId).toBe(before.participantId);
    expect(after.authSubjectHash).toBe(before.authSubjectHash);
    expect(after.participantName).toBe("alice-renamed");
  });
});
