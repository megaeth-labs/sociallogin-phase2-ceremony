import path from "node:path";

import { toDisplayPath } from "./display-path.js";

const DETAIL_PADDING = "  ";
const STEP_PADDING = "    ";

export interface SummaryOptions {
  projectName: string;
  outputDirectory: string;
  copiedR1csCount: number;
  gitInitialized: boolean;
}

export function renderSummary(options: SummaryOptions): string {
  const outputPath = toDisplayPath(options.outputDirectory);
  const circuitsPath = toDisplayPath(
    path.join(options.outputDirectory, "circuits"),
  );
  const lines = [
    "",
    "=== Ceremony Project Ready ===",
    `${DETAIL_PADDING}Project: ${options.projectName}`,
    `${DETAIL_PADDING}Output: ${outputPath}`,
    `${DETAIL_PADDING}Git: ${
      options.gitInitialized
        ? "initialized"
        : "not initialized (git unavailable or init failed)"
    }`,
  ];

  if (options.copiedR1csCount > 0) {
    lines.push(
      `${DETAIL_PADDING}Copied circuits: ${options.copiedR1csCount} .r1cs files`,
    );
  } else {
    lines.push(`${DETAIL_PADDING}Copied circuits: none`);
    lines.push(
      `${DETAIL_PADDING}Add your .r1cs files into ${circuitsPath} later.`,
    );
  }

  lines.push("", `${DETAIL_PADDING}Next steps:`);

  const steps = [`cd ${outputPath}`, "npm install"];
  if (options.copiedR1csCount === 0) {
    steps.push("Add your .r1cs files into ./circuits");
    steps.push("Update ./ceremony.config.ts with circuit and tier metadata");
  }
  steps.push(
    "npm run setup:ptau (downloads the correct PPoT .ptau and updates config)",
  );

  if (options.copiedR1csCount > 0) {
    steps.push(
      "Review ./ceremony.config.ts (circuits and tiers auto-configured)",
    );
  }

  steps.push("npm run dev");
  steps.push(
    "Review env vars and deployment settings before importing into Vercel.",
  );

  lines.push(
    ...steps.map((step, index) => `${STEP_PADDING}${index + 1}. ${step}`),
    "",
  );

  return `${lines.join("\n")}\n`;
}
