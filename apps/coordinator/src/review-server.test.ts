import { expect, it } from "vitest";
import { buildReviewServer } from "./review-server.js";

it("exposes closed setup status and blocks all ceremony operations", async () => {
  const app = buildReviewServer(async () => {});
  try {
    const setup = await app.inject({ url: "/v1/rehearsal/setup" });
    expect(setup.json()).toEqual({ mode: "review", database: "ready", contributionsEnabled: false, schedule: null, beacon: null });
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/v1/ceremonies/example/queue" })).statusCode).toBe(423);
    }
  } finally { await app.close(); }
});
it("fails readiness without leaking database errors", async () => {
  const app = buildReviewServer(async () => { throw new Error("private database detail"); });
  try {
    const response = await app.inject({ url: "/v1/rehearsal/setup" });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private");
    expect(response.json().contributionsEnabled).toBe(false);
  } finally { await app.close(); }
});
