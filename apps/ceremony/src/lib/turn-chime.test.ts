import { afterEach, describe, expect, it, vi } from "vitest";
import { enableTurnChime, playTurnChime, resetTurnChimeForTests, turnChimeEnabled } from "./turn-chime";

afterEach(() => {
  resetTurnChimeForTests();
  vi.unstubAllGlobals();
});

describe("turn chime", () => {
  it("stays silent until the participant opts in", () => {
    expect(turnChimeEnabled()).toBe(false);
    expect(playTurnChime()).toBe(false);
  });

  it("plays two tones once enabled from the opt-in click", () => {
    const started: number[] = [];
    class FakeContext {
      currentTime = 0;
      destination = {};
      resume = vi.fn(async () => undefined);
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (next: unknown) => next };
      }
      createOscillator() {
        return { type: "", frequency: { value: 0 }, connect: (next: unknown) => next,
          start: (at: number) => started.push(at), stop: vi.fn() };
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);
    expect(enableTurnChime()).toBe(true);
    expect(turnChimeEnabled()).toBe(true);
    expect(playTurnChime()).toBe(true);
    expect(started).toHaveLength(2);
  });

  it("reports when the browser cannot play sound", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(enableTurnChime()).toBe(false);
  });
});
