import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toDisplayPath } from "./display-path.js";
import type {
  GeneratedCircuitConfig,
  GeneratedTierConfig,
  ScaffoldContext,
} from "./types.js";

const TEMPLATES_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../templates",
);
const CIRCUITS_DIRECTORY = "circuits";

export async function scaffoldProject(context: ScaffoldContext): Promise<void> {
  await assertTemplatesDirectoryAvailable(TEMPLATES_DIRECTORY);
  await assertOutputDirectoryIsWritable(context.outputDirectory);
  await mkdir(context.outputDirectory, { recursive: true });

  const replacements = {
    __PROJECT_NAME__: context.projectName,
    __PROJECT_SLUG__: context.projectSlug,
    __TARGET_CONTRIBUTIONS__: String(context.targetContributions),
    __END_DATE_LITERAL__: context.endDate ? `"${context.endDate}"` : "null",
    __STATE_MANIFEST_BLOB_URL__: context.stateManifestBlobUrl,
  };

  await copyTemplateTree(
    TEMPLATES_DIRECTORY,
    context.outputDirectory,
    replacements,
  );

  const ceremonyConfigPath = path.join(
    context.outputDirectory,
    "ceremony.config.ts",
  );
  await writeFile(ceremonyConfigPath, renderCeremonyConfig(context), "utf8");
}

async function assertTemplatesDirectoryAvailable(
  templatesDirectory: string,
): Promise<void> {
  const displayPath = toDisplayPath(templatesDirectory);

  try {
    const templateStats = await stat(templatesDirectory);
    if (!templateStats.isDirectory()) {
      throw new Error(`Template path is not a directory: ${displayPath}`);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        `Templates directory is missing: ${displayPath}. Ensure templates are committed and available before running the wizard.`,
      );
    }

    throw error;
  }
}

async function copyTemplateTree(
  templateDirectory: string,
  outputDirectory: string,
  replacements: Record<string, string>,
): Promise<void> {
  const entries = await readdir(templateDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(templateDirectory, entry.name);
    const outputName = entry.name.endsWith(".tpl")
      ? entry.name.slice(0, -4)
      : entry.name;
    const targetPath = path.join(outputDirectory, outputName);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyTemplateTree(sourcePath, targetPath, replacements);
      continue;
    }

    if (entry.isFile()) {
      const templateContent = await readFile(sourcePath, "utf8");
      const renderedContent = applyReplacements(templateContent, replacements);
      await writeFile(targetPath, renderedContent, "utf8");
    }
  }
}

function applyReplacements(
  template: string,
  replacements: Record<string, string>,
): string {
  return Object.entries(replacements).reduce((accumulator, [token, value]) => {
    return accumulator.replaceAll(token, value);
  }, template);
}

async function assertOutputDirectoryIsWritable(
  outputDirectory: string,
): Promise<void> {
  const displayPath = toDisplayPath(outputDirectory);

  try {
    const outputStats = await stat(outputDirectory);
    if (!outputStats.isDirectory()) {
      throw new Error(
        `Output path exists and is not a directory: ${displayPath}`,
      );
    }

    const entries = await readdir(outputDirectory);
    if (entries.length > 0) {
      throw new Error(
        `Output directory already exists and is not empty: ${displayPath}`,
      );
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }

    throw error;
  }
}

function renderCircuitEntry(circuit: GeneratedCircuitConfig): string {
  const r1csPath = JSON.stringify(
    `${CIRCUITS_DIRECTORY}/${circuit.artifacts.r1csPath}`,
  );

  return `    {
      id: ${JSON.stringify(circuit.id)},
      label: ${JSON.stringify(circuit.label)},
      description: ${JSON.stringify(circuit.description)},
      constraints: ${JSON.stringify(circuit.constraints)},
      targetContributions: ${circuit.targetContributions},
      artifacts: {
        r1csPath: ${r1csPath},
        ptauPath: PTAU_PATH,
      },
    }`;
}

function renderTierEntry(tier: GeneratedTierConfig): string {
  const ids = tier.circuitIds.map((id) => JSON.stringify(id)).join(", ");
  return `    {
      id: ${JSON.stringify(tier.id)},
      label: ${JSON.stringify(tier.label)},
      description: ${JSON.stringify(tier.description)},
      estimatedMinutes: ${tier.estimatedMinutes},
      circuitIds: [${ids}],
    }`;
}

function renderCeremonyConfig(context: ScaffoldContext): string {
  const circuitEntries = context.circuits.map(renderCircuitEntry).join(",\n");
  const tierEntries = context.tiers.map(renderTierEntry).join(",\n");

  return `import { defaultCopy } from "./src/copy";

export type {
  CeremonyCircuitConfig,
  CeremonyConfig,
  CeremonyCopy,
  CeremonyTierConfig,
  CircuitArtifactsConfig,
  ClientCeremonyConfig,
  ClientCircuitConfig,
  TierId,
} from "./src/types/ceremony";

import type {
  CeremonyConfig,
  ClientCeremonyConfig,
} from "./src/types/ceremony";

export function getCeremonyConfig(): CeremonyConfig {
  return ceremonyConfig;
}

export function getClientConfig(): ClientCeremonyConfig {
  const { circuits, ...rest } = ceremonyConfig;
  return {
    ...rest,
    circuits: circuits.map(({ artifacts, ...circuit }) => circuit),
  };
}

const CIRCUITS_DIR = ${JSON.stringify(CIRCUITS_DIRECTORY)};
const PTAU_PATH = \`\${CIRCUITS_DIR}/pot_final.ptau\`;

export const ceremonyConfig: CeremonyConfig = {
  name: ${JSON.stringify(context.projectName)},
  slug: ${JSON.stringify(context.projectSlug)},
  description:
    "Contribute your randomness to strengthen the ceremony and improve system security.",
  targetContributions: ${context.targetContributions},
  endDate: ${context.endDate ? JSON.stringify(context.endDate) : "null"},
  queueTimeoutSeconds: 300,
  // Production always pairing-verifies contributions regardless of this flag;
  // it only disables the check in dev / CI.
  verifyContributions: false,
  tiersEnabled: ${context.tiers.length > 0},
  tiers: [
${tierEntries}
  ],
  circuits: [
${circuitEntries}
  ],
  branding: {
    shortName: ${JSON.stringify(context.projectSlug.slice(0, 2).toUpperCase())},
    accentColor: "#95C23A",
  },
  storage: {
    manifestPath: "ceremony:manifest",
    circuitStatePrefix: "ceremony:circuits",
    receiptsPath: "ceremony:receipts",
    participantContributionsPrefix: "ceremony:contributions:participants",
    participantsIndexPath: "ceremony:contributions:participants:index",
    zkeyPrefix: ${JSON.stringify(`${context.projectSlug}/zkeys`)},
  },
  copy: defaultCopy,
};
`;
}
