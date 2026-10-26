import { describe, expect, it } from "vitest";

import { startJobHeartbeat } from "../src/job-heartbeat.js";

describe("verifier job heartbeat", () => {
  it("renews immediately and aborts work when renewal fails", async () => {
    let calls = 0;
    const service = new AbortController();
    const heartbeat = await startJobHeartbeat({
      client: {
        async heartbeat() {
          calls += 1;
          if (calls > 1) throw new Error("lease lost");
          return "2030-01-01T00:00:00.000Z";
        },
      },
      jobId: "11111111-1111-4111-8111-111111111111",
      intervalMs: 1_000,
      serviceSignal: service.signal,
    });
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(heartbeat.signal.aborted).toBe(true);
    expect(() => heartbeat.assertHealthy()).toThrow(/lease lost/u);
    await heartbeat.stop();
  });
});
