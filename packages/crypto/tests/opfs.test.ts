import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  generateInitialZkey,
  requiredBrowserContributionBytes,
  verify,
} from "../src/index.js";
import { browserContribute } from "../src/worker/browser-contribute.js";
import { contributeOpfsFiles, contributeBellmanOpfsFiles } from "../src/worker/opfs-contribute.js";
import {
  createOverride,
  readExisting,
  type OpfsFastFileDescriptor,
} from "../src/worker/opfs-fastfile.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Uint8Array {
  const buffer = readFileSync(join(FIXTURES, name));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** In-memory test double for the OPFS sync-access API, not production I/O. */
class FakeOpfsFileHandle {
  readonly kind = "file";
  private locked = false;

  constructor(
    readonly name: string,
    private contents = new Uint8Array(),
  ) {}

  bytes(): Uint8Array {
    return new Uint8Array(this.contents);
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === (this as unknown as FileSystemHandle);
  }

  async createSyncAccessHandle() {
    if (this.locked) throw new Error("test handle already locked");
    this.locked = true;
    let closed = false;
    const open = () => {
      if (closed) throw new Error("test handle is closed");
    };
    const view = (buffer: ArrayBufferView) =>
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    return {
      getSize: () => {
        open();
        return this.contents.byteLength;
      },
      read: (buffer: ArrayBufferView, options?: { at?: number }) => {
        open();
        const target = view(buffer);
        const at = options?.at ?? 0;
        const count = Math.min(target.byteLength, this.contents.byteLength - at);
        if (count <= 0) return 0;
        target.set(this.contents.subarray(at, at + count));
        return count;
      },
      write: (buffer: ArrayBufferView, options?: { at?: number }) => {
        open();
        const source = view(buffer);
        const at = options?.at ?? 0;
        const end = at + source.byteLength;
        if (end > this.contents.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(this.contents);
          this.contents = grown;
        }
        this.contents.set(source, at);
        return source.byteLength;
      },
      truncate: (size: number) => {
        open();
        const resized = new Uint8Array(size);
        resized.set(this.contents.subarray(0, size));
        this.contents = resized;
      },
      flush: () => open(),
      close: () => {
        if (closed) return;
        closed = true;
        this.locked = false;
      },
    };
  }
}

function asFileHandle(file: FakeOpfsFileHandle): FileSystemFileHandle {
  return file as unknown as FileSystemFileHandle;
}

afterEach(() => vi.restoreAllMocks());

describe("OPFS fastfile compatibility adapter", () => {
  it("supports positional writes, cursor reads, endian helpers, and truncation", async () => {
    const handle = new FakeOpfsFileHandle("adapter.bin");
    const descriptor: OpfsFastFileDescriptor = {
      type: "opfs",
      handle: asFileHandle(handle),
      pageSize: 4096,
    };

    const writer = await createOverride(descriptor);
    await writer.write(Uint8Array.from([1, 2, 3]));
    await writer.writeULE32(0xa0b0c0d0);
    await writer.writeULE64(2 ** 40 + 7);
    writer.close();

    const reader = await readExisting(descriptor);
    expect(Array.from(await reader.read(3))).toEqual([1, 2, 3]);
    expect(await reader.readULE32()).toBe(0xa0b0c0d0);
    expect(await reader.readULE64()).toBe(2 ** 40 + 7);
    expect(reader.pos).toBe(15);
    await expect(reader.read(1)).rejects.toThrow(/out of bounds/);
    reader.close();
    expect(handle.bytes()).toHaveLength(15);
  });

  it("rejects use of the same descriptor while its OPFS lock is open", async () => {
    const handle = new FakeOpfsFileHandle("locked.bin", Uint8Array.of(1));
    const descriptor: OpfsFastFileDescriptor = {
      type: "opfs",
      handle: asFileHandle(handle),
    };
    const reader = await readExisting(descriptor);
    await expect(readExisting(descriptor)).rejects.toThrow(/already open/);
    reader.close();
  });
});

describe("OPFS contribution", () => {
  let genesis: Uint8Array;
  const r1cs = fixture("multiplier.r1cs");
  const ptau = fixture("pot_final.ptau");

  beforeAll(async () => {
    genesis = await generateInitialZkey(ptau, r1cs);
  });

  it("contributes to Bellman transport using OPFS and imports only the final result", async () => {
    const { zKey } = await import("snarkjs");
    const exported = { type: "mem" as const, data: new Uint8Array() };
    await zKey.exportBellman({ type: "mem", data: genesis }, exported);
    const first = new FakeOpfsFileHandle("genesis.params", exported.data);
    const next = new FakeOpfsFileHandle("next.params");
    const result = await contributeBellmanOpfsFiles(asFileHandle(first), asFileHandle(next), new Uint8Array(64).fill(8));
    expect(next.bytes().length).toBe(exported.data.length + 384);
    expect(result.contributionHash).toMatch(/^0x[0-9a-f]{128}$/);
    const imported = { type: "mem" as const, data: new Uint8Array() };
    expect(await zKey.importBellman({ type: "mem", data: genesis }, { type: "mem", data: next.bytes() }, imported)).not.toBe(false);
    expect(await verify(r1cs, ptau, imported.data)).toBe(true);
    // All sync handles have been released; neither input nor output remains locked.
    const reader = await readExisting({ type: "opfs", handle: asFileHandle(next) }); reader.close();
  });

  it("is byte-for-byte equivalent to stock snarkjs 0.7.6 for fixed randomness", async () => {
    vi.spyOn(nodeCrypto, "randomFillSync").mockImplementation(((buffer: Uint8Array) => {
      buffer.fill(0x6d);
      return buffer;
    }) as typeof nodeCrypto.randomFillSync);

    const entropy = new Uint8Array(64).fill(0xa5);
    const stock = await browserContribute(genesis, entropy, "differential-test");

    const input = new FakeOpfsFileHandle("previous.zkey", genesis);
    const output = new FakeOpfsFileHandle("new.zkey");
    const opfs = await contributeOpfsFiles(
      asFileHandle(input),
      asFileHandle(output),
      entropy,
      "differential-test",
    );

    expect(opfs.contributionHash).toBe(stock.contributionHash);
    expect(Buffer.from(output.bytes()).equals(Buffer.from(stock.zkey))).toBe(true);
    expect(await verify(r1cs, ptau, output.bytes())).toBe(true);
  });

  it("rejects input/output aliasing before truncating either file", async () => {
    const file = new FakeOpfsFileHandle("same.zkey", genesis);
    await expect(
      contributeOpfsFiles(
        asFileHandle(file),
        asFileHandle(file),
        new Uint8Array(32).fill(1),
      ),
    ).rejects.toThrow(/different files/);
    expect(Buffer.from(file.bytes()).equals(Buffer.from(genesis))).toBe(true);
  });

  it("rejects empty entropy", async () => {
    const input = new FakeOpfsFileHandle("previous.zkey", genesis);
    const output = new FakeOpfsFileHandle("new.zkey");
    await expect(
      contributeOpfsFiles(
        asFileHandle(input),
        asFileHandle(output),
        new Uint8Array(),
      ),
    ).rejects.toThrow(/entropy must not be empty/);
  });
});

describe("browser contribution capacity", () => {
  it("reserves input + output + headroom for a downloaded predecessor", () => {
    expect(requiredBrowserContributionBytes(460_000_000)).toBe(987_108_864);
  });

  it("does not double-count an input already resident in OPFS", () => {
    expect(requiredBrowserContributionBytes(460_000_000, true)).toBe(
      527_108_864,
    );
  });

  it("rejects nonsensical artifact sizes", () => {
    expect(() => requiredBrowserContributionBytes(0)).toThrow(/positive/);
    expect(() => requiredBrowserContributionBytes(Number.NaN)).toThrow(
      /positive/,
    );
  });
});

