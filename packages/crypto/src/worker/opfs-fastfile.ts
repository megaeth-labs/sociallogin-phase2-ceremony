/**
 * Minimal fastfile-compatible adapter backed by an OPFS sync access handle.
 *
 * snarkjs's browser build normally uses `fastfile`'s in-memory backend. For a
 * production-sized zkey that means retaining the predecessor, a growing output
 * buffer, and transient resize copies at the same time. This adapter keeps the
 * same cursor-oriented interface while reading and writing bounded chunks from
 * the Origin Private File System.
 *
 * `FileSystemSyncAccessHandle` is intentionally used here: it provides real
 * positional reads/writes and is only available in a dedicated worker. Calling
 * this adapter on the window/main thread will fail when the handle is opened.
 */

const DEFAULT_PAGE_SIZE = 1 << 20; // 1 MiB section-copy chunks.

interface SyncAccessHandleLike {
  getSize(): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

interface FileHandleWithSyncAccess extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
}

export interface OpfsFastFileDescriptor {
  readonly type: "opfs";
  readonly handle: FileSystemFileHandle;
  readonly pageSize?: number;
}

interface WritableByteTarget {
  set(source: Uint8Array, offset?: number): void;
}

const activeFiles = new WeakMap<OpfsFastFileDescriptor, OpfsFastFile>();

function checkedPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 4096 || value > 16 << 20) {
    throw new Error("opfs fastfile: invalid page size");
  }
  return value;
}

function checkedPosition(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`opfs fastfile: invalid ${label}`);
  }
}

function descriptor(value: unknown): OpfsFastFileDescriptor {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "opfs" ||
    typeof (value as { handle?: { createSyncAccessHandle?: unknown } }).handle
      ?.createSyncAccessHandle !== "function"
  ) {
    throw new Error("opfs fastfile: expected an OPFS file descriptor");
  }
  return value as OpfsFastFileDescriptor;
}

class OpfsFastFile {
  readonly fileName: string;
  readonly pageSize: number;
  pos = 0;
  totalSize: number;
  writingSection?: { pSectionSize: number };
  readingSection?: { p: number; size: number };

  private closed = false;

  private constructor(
    private readonly owner: OpfsFastFileDescriptor,
    private readonly access: SyncAccessHandleLike,
    private readonly readOnly: boolean,
    totalSize: number,
  ) {
    this.fileName = owner.handle.name;
    this.pageSize = checkedPageSize(owner.pageSize);
    this.totalSize = totalSize;
  }

  static async open(
    owner: OpfsFastFileDescriptor,
    readOnly: boolean,
    truncate: boolean,
  ): Promise<OpfsFastFile> {
    if (activeFiles.has(owner)) {
      throw new Error("opfs fastfile: descriptor is already open");
    }

    const handle = owner.handle as FileHandleWithSyncAccess;
    const access = await handle.createSyncAccessHandle();
    try {
      if (truncate) access.truncate(0);
      const file = new OpfsFastFile(
        owner,
        access,
        readOnly,
        truncate ? 0 : access.getSize(),
      );
      activeFiles.set(owner, file);
      return file;
    } catch (error) {
      access.close();
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("opfs fastfile: file is closed");
  }

  async write(buffer: Uint8Array, position = this.pos): Promise<void> {
    this.assertOpen();
    if (this.readOnly) throw new Error("opfs fastfile: file is read-only");
    checkedPosition(position, "write position");

    let written = 0;
    while (written < buffer.byteLength) {
      const count = this.access.write(buffer.subarray(written), {
        at: position + written,
      });
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error("opfs fastfile: short write");
      }
      written += count;
    }

    this.pos = position + buffer.byteLength;
    this.totalSize = Math.max(this.totalSize, this.pos);
  }

  async readToBuffer(
    destination: WritableByteTarget,
    offset: number,
    length: number,
    position = this.pos,
  ): Promise<void> {
    this.assertOpen();
    checkedPosition(offset, "destination offset");
    checkedPosition(length, "read length");
    checkedPosition(position, "read position");
    if (position + length > this.totalSize) {
      throw new Error("opfs fastfile: reading out of bounds");
    }

    // Read into a bounded temporary buffer. This also supports ffjavascript's
    // BigBuffer destination, which exposes `set` but is not an ArrayBufferView.
    const chunkSize = Math.min(this.pageSize, Math.max(length, 1));
    const chunk = new Uint8Array(chunkSize);
    let consumed = 0;
    while (consumed < length) {
      const wanted = Math.min(chunk.byteLength, length - consumed);
      let received = 0;
      while (received < wanted) {
        const count = this.access.read(chunk.subarray(received, wanted), {
          at: position + consumed + received,
        });
        if (!Number.isInteger(count) || count <= 0) {
          throw new Error("opfs fastfile: unexpected end of file");
        }
        received += count;
      }
      destination.set(chunk.subarray(0, wanted), offset + consumed);
      consumed += wanted;
    }
    this.pos = position + length;
  }

  async read(length: number, position = this.pos): Promise<Uint8Array> {
    checkedPosition(length, "read length");
    const output = new Uint8Array(length);
    await this.readToBuffer(output, 0, length, position);
    return output;
  }

  async writeULE32(value: number, position = this.pos): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error("opfs fastfile: invalid unsigned 32-bit value");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    await this.write(bytes, position);
  }

  async writeUBE32(value: number, position = this.pos): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error("opfs fastfile: invalid unsigned 32-bit value");
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, false);
    await this.write(bytes, position);
  }

  async writeULE64(value: number, position = this.pos): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("opfs fastfile: invalid unsigned 64-bit value");
    }
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, value >>> 0, true);
    view.setUint32(4, Math.floor(value / 2 ** 32), true);
    await this.write(bytes, position);
  }

  async readULE32(position = this.pos): Promise<number> {
    const bytes = await this.read(4, position);
    return new DataView(bytes.buffer).getUint32(0, true);
  }

  async readUBE32(position = this.pos): Promise<number> {
    const bytes = await this.read(4, position);
    return new DataView(bytes.buffer).getUint32(0, false);
  }

  async readULE64(position = this.pos): Promise<number> {
    const bytes = await this.read(8, position);
    const view = new DataView(bytes.buffer);
    const value = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
    if (!Number.isSafeInteger(value)) {
      throw new Error("opfs fastfile: unsigned 64-bit value is too large");
    }
    return value;
  }

  close(): void {
    if (this.closed) return;
    try {
      if (!this.readOnly) {
        this.access.truncate(this.totalSize);
        this.access.flush();
      }
    } finally {
      this.closed = true;
      activeFiles.delete(this.owner);
      this.access.close();
    }
  }

  async discard(): Promise<void> {
    this.close();
  }
}

export async function readExisting(value: unknown): Promise<OpfsFastFile> {
  return OpfsFastFile.open(descriptor(value), true, false);
}

export async function createOverride(value: unknown): Promise<OpfsFastFile> {
  return OpfsFastFile.open(descriptor(value), false, true);
}

/** Best-effort lock release when upstream snarkjs exits through an error path. */
export function forceCloseOpfsDescriptor(
  value: OpfsFastFileDescriptor,
): void {
  try {
    activeFiles.get(value)?.close();
  } catch {
    // Preserve the original contribution failure. Terminating the dedicated
    // worker remains the final lock-release fallback if the browser itself
    // rejects close/flush while unwinding.
  }
}
