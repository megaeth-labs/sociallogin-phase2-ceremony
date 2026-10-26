import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadContributionJournal,
  newContributionJournal,
  saveContributionJournal,
} from "./journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("contribution journal", () => {
  it("atomically persists participant-scoped recovery identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-journal-"));
    roots.push(root);
    const journal = newContributionJournal({
      ceremonyUrl: "https://coordinator.example/v1/ceremonies/moss-test",
      ceremonyId: "ceremony-1",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
    });
    Object.assign(journal, {
      queueTicketId: "ticket-1",
      leaseId: "lease-1",
      submissionId: "submission-1",
    });
    await saveContributionJournal(journal, root);

    await expect(loadContributionJournal(
      journal.ceremonyUrl,
      journal.participantId,
      root,
    )).resolves.toMatchObject({
      queueTicketId: "ticket-1",
      leaseId: "lease-1",
      submissionId: "submission-1",
    });
  });

  it("refuses a journal whose permissions are not private", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "moss-journal-"));
    roots.push(root);
    const journal = newContributionJournal({
      ceremonyUrl: "https://coordinator.example/v1/ceremonies/moss-test",
      ceremonyId: "ceremony-1",
      participantId: "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169",
    });
    await saveContributionJournal(journal, root);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(root));
    await chmod(join(root, files[0]!), 0o644);
    await expect(loadContributionJournal(
      journal.ceremonyUrl,
      journal.participantId,
      root,
    )).rejects.toThrow(/permissions/i);
  });
});
