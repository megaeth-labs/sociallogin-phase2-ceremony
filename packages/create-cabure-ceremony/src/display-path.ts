import path from "node:path";
import process from "node:process";

/**
 * Formats a path for CLI output relative to the current working directory.
 */
export function toDisplayPath(
  targetPath: string,
  basePath: string = process.cwd(),
): string {
  const relativePath = path.relative(basePath, targetPath);

  if (!relativePath) {
    return ".";
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return `./${relativePath}`;
}
