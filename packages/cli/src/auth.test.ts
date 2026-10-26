import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertCompatibleParticipantToken,
  deviceAuthPollRequest,
} from "./auth.js";

describe("participant token preflight", () => {
  it("rejects the inherited Cabure HS256 token before contacting the coordinator", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "github:1", exp: 4_000_000_000 })).toString("base64url");
    const signature = Buffer.alloc(32).toString("base64url");
    expect(() => assertCompatibleParticipantToken(`${header}.${body}.${signature}`))
      .toThrow("Ed25519 EdDSA JWT");
  });

  it("accepts the strict EdDSA JWT shape emitted by the upgraded device issuer", () => {
    const pair = generateKeyPairSync("ed25519");
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
      iss: "moss-test", aud: "moss-coordinator",
      sub: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169", name: "test-user",
      ash: "11".repeat(32), exp: Math.floor(Date.now() / 1_000) + 300,
    })).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${body}`, "ascii"), pair.privateKey).toString("base64url");
    expect(() => assertCompatibleParticipantToken(`${header}.${body}.${signature}`)).not.toThrow();
  });

  it("polls with a no-store POST body and never puts the login code in a URL", () => {
    const loginCode = "ab".repeat(16);
    const request = deviceAuthPollRequest(loginCode);
    expect(request).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify({ loginCode }),
    });
    expect(new Headers(request.headers).get("cache-control")).toBe("no-store");
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    expect(() => deviceAuthPollRequest("not-a-login-code")).toThrow(/malformed/i);
  });
});
