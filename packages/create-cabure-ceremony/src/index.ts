#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { askWizardQuestions } from "./prompts.js";
import { copyR1csCircuitsFromPath, discoverR1csFilenames } from "./circuits.js";
import { initializeGitRepository } from "./git.js";
import { scaffoldProject } from "./scaffold.js";
import { renderSummary } from "./summary.js";
import type { SummaryOptions } from "./summary.js";
import { toProjectDirectoryName } from "./validate.js";
import type { GeneratedCircuitConfig, GeneratedTierConfig } from "./types.js";

async function main(): Promise<void> {
  printHeader();
  const answers = await askWizardQuestions();

  const projectSlug = toProjectDirectoryName(answers.projectName);
  if (!projectSlug) {
    throw new Error(
      "Project name must include at least one alphanumeric character.",
    );
  }

  const outputDirectory = path.resolve(process.cwd(), projectSlug);
  const circuitsDirectory = path.join(outputDirectory, "circuits");

  let r1csFilenames: string[] = [];
  if (answers.circuitArtifactsPath) {
    r1csFilenames = await discoverR1csFilenames(answers.circuitArtifactsPath);
  }

  const circuits = buildCircuitConfigs(
    r1csFilenames,
    answers.targetContributions,
  );
  const tiers = buildTierConfigs(circuits);

  await scaffoldProject({
    outputDirectory,
    projectName: answers.projectName,
    projectSlug,
    targetContributions: answers.targetContributions,
    endDate: answers.endDate,
    circuits,
    tiers,
    stateManifestBlobUrl: "",
  });

  await mkdir(circuitsDirectory, { recursive: true });

  if (answers.circuitArtifactsPath) {
    await copyR1csCircuitsFromPath(
      answers.circuitArtifactsPath,
      circuitsDirectory,
    );
  }

  const gitInitialized = await initializeGitRepository(outputDirectory);

  printSummary({
    projectName: answers.projectName,
    outputDirectory,
    copiedR1csCount: r1csFilenames.length,
    gitInitialized,
  });
}

function circuitIdFromFilename(filename: string): string {
  return path.basename(filename, ".r1cs");
}

function toTitleCase(id: string): string {
  return id.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildCircuitConfigs(
  r1csFilenames: string[],
  targetContributions: number,
): GeneratedCircuitConfig[] {
  return r1csFilenames.map((filename) => {
    const id = circuitIdFromFilename(filename);
    return {
      id,
      label: toTitleCase(id),
      description: `${toTitleCase(id)} circuit.`,
      constraints: "unknown",
      targetContributions,
      artifacts: {
        r1csPath: filename,
        ptauPath: "pot_final.ptau",
      },
    };
  });
}

/**
 * Auto-generates tier configs from discovered circuits.
 *
 * With one circuit all tiers contain that circuit. With multiple circuits the
 * first circuit is "core", the first half is "popular", and all circuits form
 * the "all" tier.
 */
function buildTierConfigs(
  circuits: GeneratedCircuitConfig[],
): GeneratedTierConfig[] {
  if (circuits.length === 0) {
    return [];
  }

  const allIds = [...circuits]
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((c) => c.id);
  const coreIds = allIds.slice(0, 1);
  const popularIds = allIds.slice(0, Math.max(1, Math.ceil(allIds.length / 2)));

  return [
    {
      id: "core" as const,
      label: "Required",
      description: "The essential circuit. Maximum contributor diversity.",
      estimatedMinutes: Math.max(1, coreIds.length),
      circuitIds: coreIds,
    },
    {
      id: "popular" as const,
      label: "Recommended",
      description: "Most popular circuits. Good balance of time and coverage.",
      estimatedMinutes: Math.max(1, popularIds.length),
      circuitIds: popularIds,
    },
    {
      id: "all" as const,
      label: "Power User",
      description: "Full contribution. Every circuit covered.",
      estimatedMinutes: Math.max(1, allIds.length),
      circuitIds: allIds,
    },
  ];
}

function printHeader(): void {
  process.stdout.write("\n@wonderland/create-cabure-ceremony\n");
  process.stdout.write(
    "Generate a deploy-ready ceremony project with one command.\n\n",
  );
}

function printSummary(options: SummaryOptions): void {
  process.stdout.write(renderSummary(options));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nError: ${message}\n`);
  process.exitCode = 1;
});
