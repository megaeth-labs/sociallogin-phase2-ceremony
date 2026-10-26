import { open, type FileHandle } from "node:fs/promises";

export interface ByteSource {
  readonly byteLength: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export class MemoryByteSource implements ByteSource {
  readonly byteLength: number;

  constructor(private readonly bytes: Uint8Array) {
    this.byteLength = bytes.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(this.byteLength, offset, length);
    return this.bytes.slice(offset, offset + length);
  }
}

export class FileByteSource implements ByteSource {
  private constructor(
    private readonly handle: FileHandle,
    readonly byteLength: number,
  ) {}

  static async open(path: string): Promise<FileByteSource> {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("zkey input must be a regular file");
      if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error("zkey input size is invalid");
      return new FileByteSource(handle, stat.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    assertRange(this.byteLength, offset, length);
    const buffer = Buffer.allocUnsafe(length);
    let cursor = 0;
    while (cursor < length) {
      const result = await this.handle.read(buffer, cursor, length - cursor, offset + cursor);
      if (result.bytesRead === 0) throw new Error("unexpected end of zkey file");
      cursor += result.bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export function assertRange(total: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > total) {
    throw new Error("zkey read is out of range");
  }
}

export async function sourceFrom(input: ByteSource | Uint8Array | string): Promise<{ source: ByteSource; owned: boolean }> {
  if (typeof input === "string") return { source: await FileByteSource.open(input), owned: true };
  if (input instanceof Uint8Array) return { source: new MemoryByteSource(input), owned: false };
  return { source: input, owned: false };
}
