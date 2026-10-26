import { describe, expect, it } from "vitest";
import { defaultCopy } from "@/copy";
import { shareText } from "./useReceiptActions";

describe("share post", () => {
  it("includes the full contribution hash and fits X's limit with the link", () => {
    const hash = "5f65404aebbb7514a786000f2747109edd987e4e91077397999c69540ecfc8f4";
    const text = shareText(defaultCopy.complete.shareTemplate, "MOSS", {
      circuitId: "social-login", contributionIndex: 100000, contributionHash: hash,
    });
    expect(text).toContain("I'm contributor #100000");
    expect(text).toContain(`\n\n${hash}\n\n`);
    expect(text).not.toContain("{{");
    // X counts every link as 23 characters, plus the space before it.
    expect(text.length + 1 + 23).toBeLessThanOrEqual(280);
  });
});
