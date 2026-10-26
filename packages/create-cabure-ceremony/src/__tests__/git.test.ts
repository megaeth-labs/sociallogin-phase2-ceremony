import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { initializeGitRepository } from "../git.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(
    0,
    createdDirectories.length,
  )) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("initializeGitRepository", () => {
  test("creates a git repository when git init succeeds", async () => {
    const projectDirectory = await mkFixtureDirectory("cabure-git-init-");

    const initialized = await initializeGitRepository(
      projectDirectory,
      async (_command, _args, cwd) => {
        await mkdir(path.join(cwd, ".git"));
      },
    );

    expect(initialized).toBe(true);
  });

  test("continues without throwing when git init fails", async () => {
    const projectDirectory = await mkFixtureDirectory("cabure-git-skip-");

    const initialized = await initializeGitRepository(
      projectDirectory,
      async () => {
        throw new Error("git not found");
      },
    );

    expect(initialized).toBe(false);
  });
});

async function mkFixtureDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}
