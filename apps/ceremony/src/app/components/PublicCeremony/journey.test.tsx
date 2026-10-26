import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLOSE_CANCELS_NOTICE, ContributionJourney } from "./index";

describe("contribution status rendering", () => {
  it("offers no actions while the upload is being verified", () => {
    const html = renderToStaticMarkup(<ContributionJourney stage="verifying" />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Allow about 5–10 minutes");
    expect(html).not.toContain("does not prove independent publication");
  });
  it("explains an expired slot and directs participants out of the stale retry loop", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="error" error="lease is unavailable or expired" />,
    );
    expect(html).toContain("Your contribution slot is no longer active.");
    expect(html).toContain("browser pauses in the background");
    expect(html).toContain("check your contribution status");
    expect(html).toContain("Back to homepage");
    expect(html).not.toContain("Try again");
  });
  it("preserves retry for other errors", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="error" error="Upload interrupted" />,
    );
    expect(html).toContain("Upload interrupted");
    expect(html).toContain("Try again");
  });
  it("sends a failure after hand-over to its verification status, never a cancel", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="error" error="Timed out waiting for verification." submitted />,
    );
    expect(html).toContain("Check contribution status");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Cancel attempt");
  });
  it("tells a participant with a claimed slot that closing the tab cancels it", () => {
    for (const stage of ["downloading", "computing", "uploading"] as const) {
      expect(renderToStaticMarkup(<ContributionJourney stage={stage} />)).toContain(CLOSE_CANCELS_NOTICE);
    }
    for (const stage of ["waiting", "offered", "verifying", "accepted"] as const) {
      expect(renderToStaticMarkup(<ContributionJourney stage={stage} />)).not.toContain(CLOSE_CANCELS_NOTICE);
    }
  });
  it("warns about backgrounding before upload completes", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="uploading" leaseExpiresAt="2026-10-02T18:00:00Z" />,
    );
    expect(html).toContain("Switching tabs or minimizing the browser");
    expect(html).toContain("before the deadline");
  });
  it("does not claim a queue ticket exists while joining is pending", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="joining" busy />,
    );
    expect(html).toContain("No slot has been reserved yet.");
    expect(html).not.toContain("You’re in the queue.");
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
  it("does not report computation while a participant is only queued", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney stage="waiting" position={1} />,
    );
    expect(html).toContain("You’re in the queue.");
    expect(html).toContain("#1");
    expect(html).not.toContain("<progress");
    expect(html).not.toContain("Getting your starting point.");
  });
  it("tells the first in line they start when the current contributor finishes", () => {
    const note = "Your slot will be offered as soon as the current contributor is finished.";
    expect(renderToStaticMarkup(<ContributionJourney stage="waiting" position={1} />)).toContain(note);
    expect(renderToStaticMarkup(<ContributionJourney stage="waiting" position={3} />)).not.toContain(note);
  });
  it("requires clock validation before enabling a claim", () => {
    const html = renderToStaticMarkup(
      <ContributionJourney
        stage="offered"
        offerExpiresAt="2099-01-01T00:00:00Z"
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Claim my slot/);
  });
  it("leaves upload and verification percentages indeterminate", () => {
    for (const stage of ["computing", "uploading", "verifying"] as const) {
      const html = renderToStaticMarkup(
        <ContributionJourney stage={stage} progress={92} />,
      );
      expect(html).toMatch(/<progress[^>]*max="100"/);
      expect(html).not.toMatch(/<progress[^>]*value=/);
      expect(html).not.toContain("92%");
    }
  });
  it("does not call an accepted contribution final ceremony inclusion", () => {
    const html = renderToStaticMarkup(<ContributionJourney stage="accepted" />);
    expect(html).toContain("signed acceptance receipt");
    expect(html).not.toContain("Ceremony finalized");
    expect(html).not.toContain("<progress");
  });
});

it("shows the estimate and labels measured hashing progress separately", () => {
  const html = renderToStaticMarkup(
    <ContributionJourney
      stage="computing"
      progressDetail={{
        phase: "computing",
        label: "Hashing your contribution for upload",
        percent: 42,
        heartbeatPercent: 79.2,
      }}
    />,
  );
  expect(html).toContain("5–10 minutes");
  expect(html).toContain("plus queue time");
  expect(html).toContain("Hashing your contribution for upload · 42%");
  expect(html).toMatch(/<progress[^>]*value="42"/);
});
it("ignores stale worker detail once upload starts", () => {
  const html = renderToStaticMarkup(
    <ContributionJourney
      stage="uploading"
      progressDetail={{
        phase: "computing",
        label: "Hashing",
        percent: 100,
        heartbeatPercent: 85,
      }}
    />,
  );
  expect(html).not.toContain("Hashing");
  expect(html).not.toMatch(/<progress[^>]*value=/);
});
