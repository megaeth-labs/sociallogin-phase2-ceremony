import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { copyR1csCircuitsFromPath } from "../circuits.js";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(
    0,
    createdDirectories.length,
  )) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("copyR1csCircuitsFromPath", () => {
  test("copies r1cs files and ignores non-r1cs", async () => {
    const sourceDirectory = await mkFixtureDirectory();
    const targetDirectory = await mkFixtureDirectory();
    await mkdir(path.join(sourceDirectory, "nested"), { recursive: true });

    await writeFile(path.join(sourceDirectory, "deposit.r1cs"), "deposit");
    await writeFile(
      path.join(sourceDirectory, "nested", "withdraw.r1cs"),
      "withdraw",
    );
    await writeFile(
      path.join(sourceDirectory, "nested", "ignore.txt"),
      "ignore",
    );

    const copied = await copyR1csCircuitsFromPath(
      sourceDirectory,
      targetDirectory,
    );

    expect(copied).toEqual(["deposit.r1cs", "withdraw.r1cs"]);
  });

  test("renames duplicates when basenames collide", async () => {
    const sourceDirectory = await mkFixtureDirectory();
    const targetDirectory = await mkFixtureDirectory();
    await mkdir(path.join(sourceDirectory, "a"), { recursive: true });
    await mkdir(path.join(sourceDirectory, "b"), { recursive: true });

    await writeFile(path.join(sourceDirectory, "a", "circuit.r1cs"), "a");
    await writeFile(path.join(sourceDirectory, "b", "circuit.r1cs"), "b");

    const copied = await copyR1csCircuitsFromPath(
      sourceDirectory,
      targetDirectory,
    );

    expect(copied).toEqual(["circuit.r1cs", "circuit_2.r1cs"]);
  });
});

async function mkFixtureDirectory(): Promise<string> {
  const fixtureDirectory = await mkdtemp(
    path.join(tmpdir(), "cabure-circuits-"),
  );
  createdDirectories.push(fixtureDirectory);
  return fixtureDirectory;
}
