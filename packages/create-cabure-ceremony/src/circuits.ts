import { mkdir, readdir, copyFile } from "node:fs/promises";
import path from "node:path";

/**
 * Discovers `.r1cs` files recursively without copying. Returns de-duplicated
 * basenames in sorted order, suitable for building circuit configs before
 * the output directory exists.
 */
export async function discoverR1csFilenames(
  sourceDirectory: string,
): Promise<string[]> {
  const discoveredFiles = await listFilesRecursively(sourceDirectory);
  const r1csFiles = discoveredFiles
    .filter((filePath) => filePath.endsWith(".r1cs"))
    .sort((a, b) => a.localeCompare(b));

  const usedFilenames = new Set<string>();
  return r1csFiles.map((filePath) => {
    const basename = path.basename(filePath);
    return getUniqueFilename(basename, usedFilenames);
  });
}

/**
 * Discovers `.r1cs` files recursively in sourceDirectory and copies them into
 * targetDirectory with case-insensitive deduplication. Colliding names are
 * suffixed with _2, _3, etc.
 *
 * @param sourceDirectory - Directory to scan recursively for `.r1cs` files
 * @param targetDirectory - Destination directory (created if missing)
 * @returns Sorted array of copied filenames (basenames only)
 * @throws {Error} On filesystem errors (read, write, mkdir)
 *
 * @example
 * const names = await copyR1csCircuitsFromPath("./my-circuits", "./out");
 * // names: ["circuit.r1cs", "Other_2.r1cs"] if Other.r1cs existed in target
 */
export async function copyR1csCircuitsFromPath(
  sourceDirectory: string,
  targetDirectory: string,
): Promise<string[]> {
  const discoveredFiles = await listFilesRecursively(sourceDirectory);
  const r1csFiles = discoveredFiles
    .filter((filePath) => filePath.endsWith(".r1cs"))
    .sort((a, b) => a.localeCompare(b));

  await mkdir(targetDirectory, { recursive: true });

  const usedFilenames = new Set<string>();
  const existingEntries = await readdir(targetDirectory, {
    withFileTypes: true,
  });
  for (const entry of existingEntries) {
    if (entry.isFile()) {
      usedFilenames.add(entry.name.toLowerCase());
    }
  }

  const copiedFilenames: string[] = [];

  for (const filePath of r1csFiles) {
    const basename = path.basename(filePath);
    const uniqueFilename = getUniqueFilename(basename, usedFilenames);
    await copyFile(filePath, path.join(targetDirectory, uniqueFilename));
    copiedFilenames.push(uniqueFilename);
  }

  return copiedFilenames;
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function getUniqueFilename(
  initialFilename: string,
  usedFilenames: Set<string>,
): string {
  const lowerInitial = initialFilename.toLowerCase();
  if (!usedFilenames.has(lowerInitial)) {
    usedFilenames.add(lowerInitial);
    return initialFilename;
  }

  const ext = path.extname(initialFilename);
  const stem = path.basename(initialFilename, ext);

  let attempt = 2;
  let finalName: string;
  let lowerFinal: string;
  do {
    finalName = `${stem}_${attempt}${ext}`;
    lowerFinal = finalName.toLowerCase();
    attempt += 1;
  } while (usedFilenames.has(lowerFinal));

  usedFilenames.add(lowerFinal);
  return finalName;
}
