/**
 * A forward cursor over a Uint8Array that fails closed.
 *
 * Every read is checked against the real buffer length, so a truncated or lying
 * input throws here instead of returning short bytes or relying on an upstream
 * library's end-of-file behaviour. Built for parsing untrusted binary (see
 * mpcParams.ts), where a malformed length field must not read past the buffer.
 *
 * All multi-byte integers are little-endian, matching the zkey/binfile format.
 */
export class ByteReader {
  pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private require(n: number): void {
    // NaN and fractional n slip past the range checks below (NaN compares
    // false, and pos += NaN poisons the cursor), so reject non-integers first.
    if (!Number.isInteger(n) || n < 0 || this.pos + n > this.buf.length) {
      throw new Error("byteReader: read past end of buffer");
    }
  }

  // Returns a view into the underlying buffer (no copy) and advances the cursor.
  readBytes(n: number): Uint8Array {
    this.require(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readU32(): number {
    this.require(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readU64(): number {
    this.require(8);
    // Little-endian: the low 32 bits come first, then the high 32 bits.
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    // Shift the high word up by 32 bits and add the low word. This is a
    // multiply, not a bit shift, because JS bitwise operators work on 32-bit
    // integers: `hi << 32` would wrap to 0.
    const value = hi * 2 ** 32 + lo;
    // A value above 2^53 - 1 cannot be represented exactly as a JS number, so
    // it would read back wrong. Reject it rather than return a silently
    // truncated offset. Real zkey section sizes are far below this.
    if (!Number.isSafeInteger(value)) {
      throw new Error("byteReader: 64-bit value too large");
    }
    return value;
  }

  seek(p: number): void {
    if (!Number.isInteger(p) || p < 0 || p > this.buf.length) {
      throw new Error("byteReader: seek out of range");
    }
    this.pos = p;
  }
}
