import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { toDisplayPath } from "./display-path.js";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates and trims a project name.
 *
 * @param value - User-provided project name.
 * @returns The trimmed project name.
 * @throws Error if name is empty or longer than 80 characters.
 */
export function validateProjectName(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Project name is required.");
  }

  if (trimmed.length > 80) {
    throw new Error("Project name must be 80 characters or fewer.");
  }

  return trimmed;
}

/**
 * Converts a project name to a directory-safe slug.
 *
 * @param projectName - Project name to slugify.
 * @returns Lowercase, hyphenated slug (max 64 chars).
 * @throws Error if the result would be empty (no alphanumeric characters).
 */
export function toProjectDirectoryName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  if (!slug) {
    throw new Error(
      "Project name must contain at least one alphanumeric character.",
    );
  }

  return slug;
}

/**
 * Validates target contributions count.
 *
 * @param value - Number of target contributions.
 * @returns The validated value.
 * @throws Error if not a positive integer.
 */
export function validateTargetContributions(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Target contributions must be a positive integer.");
  }

  return value;
}

/**
 * Validates an optional end date in YYYY-MM-DD format against the UTC calendar date.
 *
 * @param value - Date string (blank allowed).
 * @param now - Reference "current" date used for the past-date check (defaults to `new Date()`).
 * @returns Trimmed date string or null if blank.
 * @throws Error if format is invalid, not a valid calendar date, or earlier than today.
 */
export function validateEndDate(
  value: string,
  now: Date = new Date(),
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!DATE_REGEX.test(trimmed)) {
    throw new Error("End date must use YYYY-MM-DD format.");
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("End date is not a valid calendar date.");
  }

  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (parsed.getTime() < todayUtc.getTime()) {
    throw new Error("End date must be today or in the future.");
  }

  return trimmed;
}

/**
 * Validates that a path exists, is readable, and is a directory.
 *
 * @param inputPath - Path to validate.
 * @param label - Label for error messages (e.g. "Circuit artifacts").
 * @returns The resolved absolute path.
 * @throws Error if path is blank, does not exist, is not readable, or not a directory.
 *
 * @example
 * const dir = await validateExistingPath("./circuits", "Circuit");
 */
export async function validateExistingPath(
  inputPath: string,
  label: string,
): Promise<string> {
  const trimmed = inputPath?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${label} path is required.`);
  }

  const resolvedPath = path.resolve(trimmed);
  const displayPath = toDisplayPath(resolvedPath);

  try {
    await access(resolvedPath, constants.R_OK);

    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error(`${label} path must be a directory: ${displayPath}`);
    }

    return resolvedPath;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`${label} path must be a directory`)
    ) {
      throw error;
    }

    throw new Error(
      `${label} path does not exist or is not readable: ${displayPath}`,
    );
  }
}
