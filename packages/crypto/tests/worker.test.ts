import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { generateInitialZkey, verify } from "../src/index.js";
import { browserContribute } from "../src/worker/browser-contribute.js";
import { attachWorker } from "../src/worker/contribute.worker.js";
import {
  RequestType,
  ResponseType,
  type WorkerRequest,
  type WorkerResponse,
} from "../src/worker/protocol.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): Uint8Array {
  const buf = readFileSync(join(FIXTURES, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const r1cs = loadFixture("multiplier.r1cs");
const ptau = loadFixture("pot_final.ptau");

describe("browserContribute (direct)", () => {
  let genesis: Uint8Array;

  beforeAll(async () => {
    genesis = await generateInitialZkey(ptau, r1cs);
  });

  it("produces a valid contribution", async () => {
    const entropy = new Uint8Array(32).fill(0xa5);
    const result = await browserContribute(genesis, entropy, "browser-test");

    expect(result.zkey).toBeInstanceOf(Uint8Array);
    expect(result.zkey.length).toBeGreaterThan(0);
    expect(result.contributionHash).toMatch(/^0x[0-9a-f]{128}$/);
    expect(result.zkeyHash).toMatch(/^0x[0-9a-f]{64}$/);

    const valid = await verify(r1cs, ptau, result.zkey);
    expect(valid).toBe(true);
  });

  it("does not mutate the input entropy (zeroing happens in the worker handler)", async () => {
    const entropy = new Uint8Array(32).fill(0xa5);
    const original = new Uint8Array(entropy);
    await browserContribute(genesis, entropy, "test");
    expect(Buffer.from(entropy).equals(Buffer.from(original))).toBe(true);
  });

  it("produces different zkeys on repeat calls with identical entropy", async () => {
    // snarkjs mixes 64 bytes from getRandomBytes() into the RNG seed
    // alongside the user entropy; this guards against a future change that
    // would bypass that mixing.
    const e1 = new Uint8Array(32).fill(0xa5);
    const e2 = new Uint8Array(32).fill(0xa5);
    const r1 = await browserContribute(genesis, e1, "test");
    const r2 = await browserContribute(genesis, e2, "test");
    expect(r1.contributionHash).not.toBe(r2.contributionHash);
    expect(r1.zkeyHash).not.toBe(r2.zkeyHash);
  });

  it("rejects empty entropy", async () => {
    await expect(
      browserContribute(genesis, new Uint8Array(0), "empty"),
    ).rejects.toThrow(/entropy must not be empty/i);
  });
});

describe("worker onmessage protocol", () => {
  type PostedMessage = { msg: WorkerResponse; transfer: Transferable[] };

  let posted: PostedMessage[];
  let onmessageHandler:
    | ((event: MessageEvent<WorkerRequest>) => unknown)
    | null;

  beforeAll(() => {
    const mockSelf = {
      postMessage: (
        msg: WorkerResponse,
        options?: { transfer?: Transferable[] },
      ) => {
        posted.push({ msg, transfer: options?.transfer ?? [] });
      },
      onmessage: null as
        | ((event: MessageEvent<WorkerRequest>) => unknown)
        | null,
    };
    attachWorker(mockSelf);
    onmessageHandler = mockSelf.onmessage;
  });

  beforeEach(() => {
    posted = [];
  });

  function fireMessage(data: WorkerRequest): Promise<unknown> {
    if (!onmessageHandler) {
      throw new Error("worker onmessage was not assigned by attachWorker");
    }
    return Promise.resolve(
      onmessageHandler({ data } as MessageEvent<WorkerRequest>),
    );
  }

  it("handles a Contribute request end-to-end", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const entropy = new Uint8Array(32).fill(0x42);

    await fireMessage({
      type: RequestType.Contribute,
      prevZkey: genesis,
      entropy,
      name: "worker-test",
    });

    expect(posted).toHaveLength(3);
    expect(posted[0].msg).toEqual({
      type: ResponseType.Progress,
      stage: "computing",
      percent: 0,
    });
    expect(posted[1].msg).toEqual({
      type: ResponseType.Progress,
      stage: "done",
      percent: 100,
    });

    const result = posted[2].msg;
    expect(result.type).toBe(ResponseType.Result);
    if (result.type !== ResponseType.Result) throw new Error("unreachable");

    expect(result.newZkey).toBeInstanceOf(Uint8Array);
    expect(result.contributionHash).toMatch(/^0x[0-9a-f]{128}$/);
    expect(result.zkeyHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(posted[2].transfer).toEqual([result.newZkey.buffer]);

    const valid = await verify(r1cs, ptau, result.newZkey);
    expect(valid).toBe(true);

    for (const byte of entropy) expect(byte).toBe(0);
  });

  it("handles a GenerateEntropy request", async () => {
    await fireMessage({ type: RequestType.GenerateEntropy });

    expect(posted).toHaveLength(1);
    const reply = posted[0].msg;
    expect(reply.type).toBe(ResponseType.Entropy);
    if (reply.type !== ResponseType.Entropy) throw new Error("unreachable");
    expect(reply.data).toBeInstanceOf(Uint8Array);
    expect(reply.data.length).toBe(64);
    expect(posted[0].transfer).toEqual([reply.data.buffer]);
  });

  it("posts an Error response when entropy is empty", async () => {
    // End-to-end coverage of the empty-entropy guard in `browserContribute`:
    // the worker must turn the thrown error into a clean Error response
    // instead of hanging or producing a silent no-op.
    const garbage = new Uint8Array(64).fill(0xde);
    const entropy = new Uint8Array(0);

    await fireMessage({
      type: RequestType.Contribute,
      prevZkey: garbage,
      entropy,
      name: "empty-entropy",
    });

    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted[0].msg.type).toBe(ResponseType.Progress);

    const last = posted[posted.length - 1].msg;
    expect(last.type).toBe(ResponseType.Error);
    if (last.type !== ResponseType.Error) throw new Error("unreachable");
    expect(last.message).toMatch(/entropy must not be empty/i);
  });

  it("posts an Error response when contribute throws", async () => {
    const garbage = new Uint8Array(0);
    const entropy = new Uint8Array(32).fill(0x01);

    await fireMessage({
      type: RequestType.Contribute,
      prevZkey: garbage,
      entropy,
      name: "should-fail",
    });

    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted[0].msg.type).toBe(ResponseType.Progress);

    const errorMsg = posted[posted.length - 1].msg;
    expect(errorMsg.type).toBe(ResponseType.Error);
    if (errorMsg.type !== ResponseType.Error) throw new Error("unreachable");
    expect(typeof errorMsg.message).toBe("string");
    expect(errorMsg.message.length).toBeGreaterThan(0);

    // Entropy must be zeroed even on the failure branch (regression guard
    // for the toxic-waste hygiene fix).
    for (const byte of entropy) expect(byte).toBe(0);
  });
});
