/**
 * The small `@iden3/binfileutils` surface used by snarkjs Phase 2, wired to
 * the OPFS fastfile adapter. Binary layout and cursor semantics intentionally
 * match binfileutils 0.0.12; no proving arithmetic lives in this module.
 */

import { Scalar } from "ffjavascript";
import {
  createOverride,
  readExisting,
  type OpfsFastFileDescriptor,
} from "./opfs-fastfile.js";

interface Section {
  p: number;
  size: number;
}

export type Sections = Array<Section[] | undefined>;

interface BinFile {
  readonly fileName: string;
  readonly pageSize: number;
  readonly totalSize: number;
  pos: number;
  writingSection?: { pSectionSize: number };
  readingSection?: Section;
  read(length: number, position?: number): Promise<Uint8Array>;
  readToBuffer(
    destination: { set(source: Uint8Array, offset?: number): void },
    offset: number,
    length: number,
    position?: number,
  ): Promise<void>;
  write(buffer: Uint8Array, position?: number): Promise<void>;
  readULE32(position?: number): Promise<number>;
  readULE64(position?: number): Promise<number>;
  writeULE32(value: number, position?: number): Promise<void>;
  writeULE64(value: number, position?: number): Promise<void>;
  close(): void;
}

function onlySection(sections: Sections, id: number): Section {
  const matches = sections[id];
  if (!matches) throw new Error(`binfile: missing section ${id}`);
  if (matches.length !== 1) throw new Error(`binfile: duplicate section ${id}`);
  return matches[0];
}

export async function readBinFile(
  file: OpfsFastFileDescriptor,
  type: string,
  maxVersion: number,
): Promise<{ fd: BinFile; sections: Sections }> {
  const fd = (await readExisting(file)) as BinFile;
  const magic = await fd.read(4);
  const actualType = String.fromCharCode(...magic);
  if (actualType !== type) throw new Error(`${fd.fileName}: invalid format`);

  const version = await fd.readULE32();
  if (version > maxVersion) throw new Error("binfile: version not supported");

  const sectionCount = await fd.readULE32();
  // A Groth16 zkey currently has ten sections. This generous bound prevents a
  // malformed header from forcing an unbounded scan or sparse-array growth.
  if (sectionCount > 1024) throw new Error("binfile: unreasonable section count");

  const sections: Sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const id = await fd.readULE32();
    if (id > 1024) throw new Error("binfile: unreasonable section identifier");
    const size = await fd.readULE64();
    const end = fd.pos + size;
    if (!Number.isSafeInteger(end) || end > fd.totalSize) {
      throw new Error("binfile: section extends past end of file");
    }
    (sections[id] ??= []).push({ p: fd.pos, size });
    fd.pos = end;
  }

  return { fd, sections };
}

export async function createBinFile(
  file: OpfsFastFileDescriptor,
  type: string,
  version: number,
  sectionCount: number,
): Promise<BinFile> {
  if (type.length !== 4) throw new Error("binfile: type must be four bytes");
  const fd = (await createOverride(file)) as BinFile;
  const magic = new Uint8Array(4);
  for (let i = 0; i < 4; i++) magic[i] = type.charCodeAt(i);
  await fd.write(magic);
  await fd.writeULE32(version);
  await fd.writeULE32(sectionCount);
  return fd;
}

export async function startWriteSection(fd: BinFile, id: number): Promise<void> {
  if (fd.writingSection) throw new Error("binfile: already writing a section");
  await fd.writeULE32(id);
  fd.writingSection = { pSectionSize: fd.pos };
  await fd.writeULE64(0);
}

export async function endWriteSection(fd: BinFile): Promise<void> {
  if (!fd.writingSection) throw new Error("binfile: not writing a section");
  const { pSectionSize } = fd.writingSection;
  const sectionSize = fd.pos - pSectionSize - 8;
  const end = fd.pos;
  fd.pos = pSectionSize;
  await fd.writeULE64(sectionSize);
  fd.pos = end;
  delete fd.writingSection;
}

export async function startReadUniqueSection(
  fd: BinFile,
  sections: Sections,
  id: number,
): Promise<void> {
  if (fd.readingSection) throw new Error("binfile: already reading a section");
  const section = onlySection(sections, id);
  fd.pos = section.p;
  fd.readingSection = section;
}

export async function endReadSection(
  fd: BinFile,
  noCheck = false,
): Promise<void> {
  if (!fd.readingSection) throw new Error("binfile: not reading a section");
  if (!noCheck && fd.pos - fd.readingSection.p !== fd.readingSection.size) {
    throw new Error("binfile: invalid section size while reading");
  }
  delete fd.readingSection;
}

export async function writeBigInt(
  fd: BinFile,
  value: unknown,
  byteLength: number,
  position?: number,
): Promise<void> {
  const buffer = new Uint8Array(byteLength);
  Scalar.toRprLE(buffer, 0, value, byteLength);
  await fd.write(buffer, position);
}

export async function readBigInt(
  fd: BinFile,
  byteLength: number,
  position?: number,
): Promise<unknown> {
  const buffer = await fd.read(byteLength, position);
  return Scalar.fromRprLE(buffer, 0, byteLength);
}

export async function copySection(
  source: BinFile,
  sections: Sections,
  destination: BinFile,
  id: number,
  requestedSize?: number,
): Promise<void> {
  const section = onlySection(sections, id);
  const size = requestedSize ?? section.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > section.size) {
    throw new Error("binfile: invalid section copy size");
  }

  await startReadUniqueSection(source, sections, id);
  await startWriteSection(destination, id);
  for (let offset = 0; offset < size; offset += source.pageSize) {
    const length = Math.min(size - offset, source.pageSize);
    await destination.write(await source.read(length));
  }
  await endWriteSection(destination);
  await endReadSection(source, size !== section.size);
}
