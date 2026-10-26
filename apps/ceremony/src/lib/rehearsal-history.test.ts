import { expect, it } from "vitest";
import { getRehearsalHistory } from "./rehearsal-history";
import snapshot from "./rehearsal-history.json";

it("verifies the rehearsal snapshot from genesis to its sealed head, newest first", async () => {
  const history = await getRehearsalHistory();
  expect(history.map(({ receipt }) => receipt.contributionIndex)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  expect(history[0].artifactDownloadUrl).toBe(history[0].receipt.successor.urls[0]);
});
it("rejects a receipt that was altered after signing", async () => {
  const original = snapshot.receipts[2].payload.participantPseudonym;
  snapshot.receipts[2].payload.participantPseudonym = "someone-else";
  try {
    await expect(getRehearsalHistory()).rejects.toThrow();
  } finally {
    snapshot.receipts[2].payload.participantPseudonym = original;
  }
});
