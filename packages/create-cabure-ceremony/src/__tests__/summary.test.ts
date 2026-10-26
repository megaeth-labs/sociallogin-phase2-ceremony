import path from "node:path";
import process from "node:process";

import { describe, expect, test } from "vitest";

import { renderSummary } from "../summary.js";

describe("summary output", () => {
  test("renders a distinct success section with relative paths", () => {
    const summary = renderSummary({
      projectName: "Privacy Pools v2",
      outputDirectory: path.join(process.cwd(), "privacy-pools-v2"),
      copiedR1csCount: 2,
      gitInitialized: true,
    });

    expect(summary).toContain("=== Ceremony Project Ready ===");
    expect(summary).toContain("  Output: ./privacy-pools-v2");
    expect(summary).toContain("  Git: initialized");
    expect(summary).toContain("    1. cd ./privacy-pools-v2");
    expect(summary).toContain("    2. npm install");
    expect(summary).toContain("npm run setup:ptau");
    expect(summary).toContain(
      "Review env vars and deployment settings before importing into Vercel.",
    );
    expect(summary).not.toContain(process.cwd());
  });

  test("guides manual circuit setup when no circuits were copied", () => {
    const summary = renderSummary({
      projectName: "Privacy Pools v2",
      outputDirectory: path.join(process.cwd(), "privacy-pools-v2"),
      copiedR1csCount: 0,
      gitInitialized: false,
    });

    expect(summary).toContain("  Copied circuits: none");
    expect(summary).toContain(
      "  Git: not initialized (git unavailable or init failed)",
    );
    expect(summary).toContain(
      "  Add your .r1cs files into ./privacy-pools-v2/circuits later.",
    );
    expect(summary).toContain("    3. Add your .r1cs files into ./circuits");
    expect(summary).toContain(
      "Update ./ceremony.config.ts with circuit and tier metadata",
    );
    expect(summary).toContain("npm run setup:ptau");
  });
});
