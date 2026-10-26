import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { WizardAnswers } from "./types.js";
import {
  validateEndDate,
  validateExistingPath,
  validateProjectName,
  validateTargetContributions,
} from "./validate.js";

interface PromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

interface PromptSession {
  question(query: string): Promise<string>;
  write(chunk: string): void;
}

const STEP_PADDING = "  ";
const DETAIL_PADDING = "     ";
const OPTION_PADDING = "    ";
const DEFAULT_TARGET_OPTION_INDEX = 0;

const TARGET_OPTIONS = [
  { id: "100", label: "100 contributions (default)" },
  { id: "500", label: "500 contributions" },
  { id: "1000", label: "1000 contributions" },
  { id: "custom", label: "Custom value" },
];

/**
 * Runs the interactive wizard prompts, collecting project name, target contributions,
 * end date, and optional circuit path.
 *
 * @param context - Optional I/O streams for prompts (defaults to stdin/stdout)
 * @returns Promise resolving to WizardAnswers with all collected values
 *
 * @example
 * const answers = await askWizardQuestions();
 * console.log(answers.projectName);
 */
export async function askWizardQuestions(
  context: PromptContext = {},
): Promise<WizardAnswers> {
  const rl = createInterface({
    input: context.input ?? process.stdin,
    output: context.output ?? process.stdout,
  });

  try {
    return await runWizardQuestions(rl);
  } finally {
    rl.close();
  }
}

export async function runWizardQuestions(
  rl: PromptSession,
): Promise<WizardAnswers> {
  const projectName = await askWithValidation(
    rl,
    `${STEP_PADDING}1) Project name (displayed in the ceremony UI): `,
    validateProjectName,
  );

  const targetContributions = await askTargetContributions(rl);

  const endDate = await askWithValidation(
    rl,
    `${STEP_PADDING}3) End date (optional YYYY-MM-DD, press enter to skip): `,
    validateEndDate,
  );

  let circuitArtifactsPath: string | null = null;
  for (;;) {
    const circuitPathRaw = await rl.question(
      `${STEP_PADDING}4) Circuit artifacts path (press Enter if you'll add them later): `,
    );
    const trimmed = circuitPathRaw.trim();
    if (!trimmed) {
      break;
    }
    try {
      circuitArtifactsPath = await validateExistingPath(
        trimmed,
        "Circuit artifacts",
      );
      break;
    } catch (error) {
      rl.write(`${DETAIL_PADDING}${toMessage(error)}\n`);
    }
  }

  return {
    projectName,
    targetContributions,
    endDate,
    circuitArtifactsPath,
  };
}

async function askTargetContributions(rl: PromptSession): Promise<number> {
  for (;;) {
    rl.write(`\n${STEP_PADDING}2) Target contributions\n`);
    rl.write(
      `${DETAIL_PADDING}Press Enter to accept the default: 100 contributions.\n\n`,
    );
    TARGET_OPTIONS.forEach((option, index) => {
      rl.write(`${OPTION_PADDING}${index + 1}. ${option.label}\n`);
    });
    rl.write("\n");

    const optionRaw = await rl.question(
      `${STEP_PADDING}Select a target tier [${DEFAULT_TARGET_OPTION_INDEX + 1}]: `,
    );
    const selectedIndex = parseTargetOptionIndex(optionRaw);

    if (
      typeof selectedIndex !== "number" ||
      selectedIndex < 0 ||
      selectedIndex >= TARGET_OPTIONS.length
    ) {
      rl.write(`${DETAIL_PADDING}Please choose a valid option number.\n\n`);
      continue;
    }

    const selected = TARGET_OPTIONS[selectedIndex];
    if (selected.id !== "custom") {
      return validateTargetContributions(Number.parseInt(selected.id, 10));
    }

    for (;;) {
      const customValueRaw = await rl.question(
        `${STEP_PADDING}Enter a custom target contribution count: `,
      );
      const customValue = parseWholeNumber(customValueRaw);
      if (typeof customValue !== "number") {
        rl.write(
          `${DETAIL_PADDING}Target contributions must be a whole number.\n\n`,
        );
        continue;
      }

      try {
        return validateTargetContributions(customValue);
      } catch (error) {
        rl.write(`${DETAIL_PADDING}${toMessage(error)}\n\n`);
      }
    }
  }
}

async function askWithValidation<T>(
  rl: PromptSession,
  question: string,
  validate: (value: string) => T | Promise<T>,
): Promise<T> {
  for (;;) {
    const answer = await rl.question(question);
    try {
      return await validate(answer);
    } catch (error) {
      rl.write(`${DETAIL_PADDING}${toMessage(error)}\n`);
    }
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWholeNumber(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const numericValue = Number(trimmed);
  if (!Number.isSafeInteger(numericValue)) {
    return null;
  }

  return numericValue;
}

function parseTargetOptionIndex(rawValue: string): number | null {
  if (!rawValue.trim()) {
    return DEFAULT_TARGET_OPTION_INDEX;
  }

  const selectedNumber = parseWholeNumber(rawValue);
  if (typeof selectedNumber !== "number") {
    return null;
  }

  return selectedNumber - 1;
}
