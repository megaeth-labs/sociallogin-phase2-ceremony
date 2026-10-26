import { describe, it, expect } from "vitest";
import { ByteReader } from "../src/byteReader.js";

// Little-endian helpers for building fixtures.
function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

describe("ByteReader reads", () => {
  it("reads little-endian u32 and advances the cursor", () => {
    const reader = new ByteReader(Uint8Array.from(u32le(0x01020304)));
    expect(reader.readU32()).toBe(0x01020304);
    expect(reader.pos).toBe(4);
  });

  it("reads the full u32 range without sign issues", () => {
    const reader = new ByteReader(Uint8Array.from(u32le(0xffffffff)));
    expect(reader.readU32()).toBe(0xffffffff);
  });

  it("reads little-endian u64 within the safe integer range", () => {
    // 0x0000000100000002 = 2^32 + 2.
    const bytes = Uint8Array.from([...u32le(2), ...u32le(1)]);
    const reader = new ByteReader(bytes);
    expect(reader.readU64()).toBe(0x1_0000_0002);
    expect(reader.pos).toBe(8);
  });

  it("returns a zero-copy view from readBytes and advances", () => {
    const buf = Uint8Array.from([10, 20, 30, 40]);
    const reader = new ByteReader(buf);
    const slice = reader.readBytes(2);
    expect(Array.from(slice)).toEqual([10, 20]);
    expect(reader.pos).toBe(2);
    // It is a view: mutating the source is visible through the slice.
    buf[0] = 99;
    expect(slice[0]).toBe(99);
  });

  it("reads sequential fields in order", () => {
    const buf = Uint8Array.from([...u32le(7), 0xaa, 0xbb]);
    const reader = new ByteReader(buf);
    expect(reader.readU32()).toBe(7);
    expect(Array.from(reader.readBytes(2))).toEqual([0xaa, 0xbb]);
  });

  it("honors the buffer's byteOffset (subarray input)", () => {
    const backing = Uint8Array.from([0xff, 0xff, ...u32le(5)]);
    const reader = new ByteReader(backing.subarray(2));
    expect(reader.readU32()).toBe(5);
  });
});

describe("ByteReader fails closed", () => {
  it("throws when readBytes runs past the end", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2]));
    expect(() => reader.readBytes(3)).toThrow(/read past end/);
  });

  it("throws when readU32 has fewer than four bytes", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2, 3]));
    expect(() => reader.readU32()).toThrow(/read past end/);
  });

  it("throws when readU64 has fewer than eight bytes", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2, 3, 4, 5, 6, 7]));
    expect(() => reader.readU64()).toThrow(/read past end/);
  });

  it("rejects a u64 above the safe integer range", () => {
    // High word 0x00200000 puts the value above 2^53.
    const bytes = Uint8Array.from([...u32le(0), ...u32le(0x00200000)]);
    const reader = new ByteReader(bytes);
    expect(() => reader.readU64()).toThrow(/too large/);
  });

  it("rejects a negative read length", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2, 3]));
    expect(() => reader.readBytes(-1)).toThrow(/read past end/);
  });

  it("rejects a seek past the end and before the start", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2, 3]));
    expect(() => reader.seek(4)).toThrow(/seek out of range/);
    expect(() => reader.seek(-1)).toThrow(/seek out of range/);
  });

  it("allows seeking to the exact end (a valid empty position)", () => {
    const reader = new ByteReader(Uint8Array.from([1, 2, 3]));
    reader.seek(3);
    expect(reader.pos).toBe(3);
    expect(() => reader.readBytes(1)).toThrow(/read past end/);
  });
});
