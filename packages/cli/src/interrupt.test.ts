import { describe, expect, it, vi } from "vitest";

import { queueInterruptHandler, type InterruptPhase } from "./interrupt.js";

function setup(phase: InterruptPhase, leaveQueue: () => Promise<void> = async () => undefined) {
  const calls = { leave: 0, forget: 0, exits: [] as number[], logs: [] as string[] };
  const handler = queueInterruptHandler({
    phase: () => phase,
    leaveQueue: async () => { calls.leave += 1; await leaveQueue(); },
    forgetQueue: async () => { calls.forget += 1; },
    log: (message) => { calls.logs.push(message); },
    exit: (code) => { calls.exits.push(code); },
    timeoutMs: 50,
  });
  return { handler, calls };
}

describe("queue interrupt handler", () => {
  it("leaves the queue once while waiting, forgets the ticket and exits non-zero", async () => {
    const { handler, calls } = setup("waiting");
    await handler("SIGINT");
    expect(calls.leave).toBe(1);
    expect(calls.forget).toBe(1);
    expect(calls.exits).toEqual([130]);
    expect(calls.logs.join("\n")).toMatch(/Left the queue/u);
  });

  it("keeps a claimed slot reserved and says a rerun resumes it", async () => {
    const { handler, calls } = setup("leased");
    await handler("SIGTERM");
    expect(calls.leave).toBe(0);
    expect(calls.forget).toBe(0);
    expect(calls.exits).toEqual([143]);
    expect(calls.logs.join("\n")).toMatch(/stays reserved until it lapses.*resume/u);
  });

  it("still exits when leaving the queue fails or hangs", async () => {
    const failed = setup("waiting", async () => { throw new Error("network down"); });
    await failed.handler("SIGINT");
    expect(failed.calls.exits).toEqual([130]);
    expect(failed.calls.logs.join("\n")).toMatch(/Could not confirm leaving the queue/u);

    const hung = setup("waiting", () => new Promise(() => undefined));
    await hung.handler("SIGINT");
    expect(hung.calls.exits).toEqual([130]);
    expect(hung.calls.forget).toBe(1);
  });

  it("exits immediately on a second interrupt without waiting for the leave request", async () => {
    let release: () => void = () => undefined;
    const { handler, calls } = setup("waiting", () => new Promise<void>((resolve) => { release = resolve; }));
    const first = handler("SIGINT");
    await vi.waitFor(() => expect(calls.leave).toBe(1));
    await handler("SIGINT");
    expect(calls.exits).toEqual([130]);
    expect(calls.leave).toBe(1);
    release();
    await first;
  });

  it("exits at once before anything is held", async () => {
    const { handler, calls } = setup("idle");
    await handler("SIGINT");
    expect(calls.leave).toBe(0);
    expect(calls.exits).toEqual([130]);
  });
});
