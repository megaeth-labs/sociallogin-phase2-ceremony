import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  toProjectDirectoryName,
  validateEndDate,
  validateExistingPath,
  validateProjectName,
  validateTargetContributions,
} from "../validate.js";

describe("validate helpers", () => {
  test("validateProjectName trims and accepts valid names", () => {
    expect(validateProjectName("  Privacy Pools v2  ")).toBe(
      "Privacy Pools v2",
    );
  });

  test("validateProjectName rejects empty names", () => {
    expect(() => validateProjectName("   ")).toThrowError(
      "Project name is required.",
    );
  });

  test("validateEndDate accepts blank or proper yyyy-mm-dd", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    expect(validateEndDate("", now)).toBeNull();
    expect(validateEndDate("2026-03-27", now)).toBe("2026-03-27");
  });

  test("validateEndDate accepts today", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    expect(validateEndDate("2026-01-15", now)).toBe("2026-01-15");
  });

  test("validateEndDate compares against the UTC calendar date", () => {
    const now = new Date("2026-01-15T01:30:00.000Z");
    expect(validateEndDate("2026-01-15", now)).toBe("2026-01-15");
    expect(() => validateEndDate("2026-01-14", now)).toThrowError(
      "End date must be today or in the future.",
    );
  });

  test("validateEndDate rejects invalid calendar dates", () => {
    expect(() => validateEndDate("2026-02-30")).toThrowError(
      "End date is not a valid calendar date.",
    );
  });

  test("validateEndDate rejects past dates", () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    expect(() => validateEndDate("2023-01-29", now)).toThrowError(
      "End date must be today or in the future.",
    );
    expect(() => validateEndDate("2026-01-14", now)).toThrowError(
      "End date must be today or in the future.",
    );
  });

  test("validateTargetContributions rejects non-positive values", () => {
    expect(() => validateTargetContributions(0)).toThrowError(
      "Target contributions must be a positive integer.",
    );
  });

  test("toProjectDirectoryName normalizes names", () => {
    expect(toProjectDirectoryName("Privacy Pools v2")).toBe("privacy-pools-v2");
  });

  test("toProjectDirectoryName throws for non-alphanumeric input", () => {
    expect(() => toProjectDirectoryName("!!!")).toThrowError(
      "Project name must contain at least one alphanumeric character.",
    );
  });

  test("validateExistingPath accepts directories", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cabure-validate-dir-"),
    );
    await expect(
      validateExistingPath(directory, "Circuit artifacts"),
    ).resolves.toBe(directory);
    await rm(directory, { recursive: true, force: true });
  });

  test("validateExistingPath rejects blank/whitespace inputs", async () => {
    await expect(validateExistingPath("", "Test")).rejects.toThrow(
      "path is required",
    );
    await expect(validateExistingPath("   ", "Test")).rejects.toThrow(
      "path is required",
    );
  });

  test("validateExistingPath rejects file paths", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cabure-validate-file-"),
    );
    const filePath = path.join(directory, "circuit.r1cs");
    await writeFile(filePath, "r1cs");

    await expect(
      validateExistingPath(filePath, "Circuit artifacts"),
    ).rejects.toThrowError("Circuit artifacts path must be a directory");

    await rm(directory, { recursive: true, force: true });
  });
});
