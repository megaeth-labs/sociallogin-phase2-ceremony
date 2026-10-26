import { describe, expect, it } from "vitest";
import { githubOAuthCredentials } from "./env";

describe("GitHub OAuth credential naming", () => {
  const legacy = { GITHUB_CLIENT_ID: "old-id", GITHUB_CLIENT_SECRET: "old-secret" };
  it("prefers the new pair over legacy placeholders", () => {
    expect(githubOAuthCredentials({ ...legacy, GITHUB_OAUTH_CLIENT_ID: " new-id ", GITHUB_OAUTH_CLIENT_SECRET: " new-secret " }))
      .toEqual({ clientId: "new-id", clientSecret: "new-secret" });
  });
  it("preserves legacy configurations", () => {
    expect(githubOAuthCredentials(legacy)).toEqual({ clientId: "old-id", clientSecret: "old-secret" });
  });
  it("does not mix a partial new pair with the old app", () => {
    expect(githubOAuthCredentials({ ...legacy, GITHUB_OAUTH_CLIENT_ID: "new-id" }))
      .toEqual({ clientId: "new-id", clientSecret: "" });
    expect(githubOAuthCredentials({ ...legacy, GITHUB_OAUTH_CLIENT_SECRET: "new-secret" }))
      .toEqual({ clientId: "", clientSecret: "new-secret" });
  });
  it("allows secretless builds", () => {
    expect(githubOAuthCredentials({})).toEqual({ clientId: "", clientSecret: "" });
  });
});
