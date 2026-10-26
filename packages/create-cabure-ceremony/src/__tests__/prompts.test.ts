import { describe, expect, test } from "vitest";

import { runWizardQuestions } from "../prompts.js";

describe("wizard prompts", () => {
  test("defaults target contributions to 100 when the user presses enter", async () => {
    const { answers, output } = await runWizard([
      "Privacy Pools v2",
      "",
      "",
      "",
    ]);

    expect(answers).toEqual({
      projectName: "Privacy Pools v2",
      targetContributions: 100,
      endDate: null,
      circuitArtifactsPath: null,
    });
    expect(output).toContain("  2) Target contributions");
    expect(output).toContain(
      "Press Enter to accept the default: 100 contributions.",
    );
    expect(output).toContain("  Select a target tier [1]: ");
  });

  test("makes the circuit artifacts step explicitly skippable for later", async () => {
    const { output } = await runWizard(["Privacy Pools v2", "", "", ""]);

    expect(output).toContain(
      "  4) Circuit artifacts path (press Enter if you'll add them later): ",
    );
  });

  test("re-prompts only for the custom value after an invalid custom entry", async () => {
    const { answers, output } = await runWizard([
      "Privacy Pools v2",
      "4",
      "1,3",
      "250",
      "",
      "",
    ]);

    expect(answers.targetContributions).toBe(250);
    expect(output).toContain("Target contributions must be a whole number.");

    const tierMenuOccurrences =
      output.split("2) Target contributions").length - 1;
    expect(tierMenuOccurrences).toBe(1);

    const customPromptOccurrences =
      output.split("Enter a custom target contribution count:").length - 1;
    expect(customPromptOccurrences).toBe(2);
  });
});

async function runWizard(answers: string[]): Promise<{
  answers: Awaited<ReturnType<typeof runWizardQuestions>>;
  output: string;
}> {
  let transcript = "";
  let answerIndex = 0;

  const result = await runWizardQuestions({
    async question(prompt: string): Promise<string> {
      transcript += prompt;

      const answer = answers[answerIndex];
      answerIndex += 1;

      if (typeof answer !== "string") {
        throw new Error(`Missing mock answer for prompt: ${prompt}`);
      }

      return answer;
    },
    write(chunk: string): void {
      transcript += chunk;
    },
  });

  return {
    answers: result,
    output: transcript,
  };
}
