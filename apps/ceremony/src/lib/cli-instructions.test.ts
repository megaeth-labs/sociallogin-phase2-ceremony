import { describe, expect, it } from "vitest";
import { buildReceiptVerificationCommand, buildRepositorySetup, isLocalCoordinator } from "./cli-instructions";

describe("coordinator origin", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("treats %s as local", (host) => {
    expect(isLocalCoordinator(`http://${host}:58787`)).toBe(true);
  });
  it("accepts hosted HTTPS and rejects unsafe URLs", () => {
    expect(isLocalCoordinator("https://coordinator.example")).toBe(false);
    for (const url of ["http://remote.example", "https://user:password@example.test", "https://example.test/path", "https://example.test/?key=value"]) {
      expect(() => isLocalCoordinator(url)).toThrow();
    }
  });
});

it("generates an offline receipt check against the signing key, without the manifest or network", () => {
  const command = buildReceiptVerificationCommand({ ceremonyId: "789a742d-af60-44d7-86b6-19182f666a80" });
  expect(command).toContain("verify-receipt ./receipt.json");
  expect(command).toContain("--signing-key ./ceremony-signing-key.pub");
  expect(command).toContain("--ceremony-id '789a742d-af60-44d7-86b6-19182f666a80'");
  expect(command).not.toMatch(/manifest|slug|https:|auth-url|token-file|allow-/);
  expect(command).toContain(String.fromCharCode(92, 10));
  expect(command.split("\n").slice(1).every((line) => line.startsWith("  --"))).toBe(true);
  expect(() => buildReceiptVerificationCommand({ ceremonyId: "x';echo bad" })).toThrow();
});

it("pins repository instructions to a full release hash and rejects executable input", () => {
  const hash = "7c1e747c2618f4f3b24d7e5a61cc61c39c910d17";
  expect(buildRepositorySetup(hash)).toContain(`git checkout --detach ${hash}`);
  expect(buildRepositorySetup(hash)).not.toContain("REVIEWED_RELEASE_COMMIT");
  for (const value of ["main", "abc123", `${hash}; echo unsafe`, "$(whoami)"]) {
    expect(() => buildRepositorySetup(value)).toThrow();
  }
});
