import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ParticipantActivity, ReceiptResponse } from "@/lib/api";
import { participantActivityStage } from "@/lib/participant-activity";
import { CLOSED_ATTEMPT_NOTICE, ParticipantActivityCard } from "./index";
import { CompleteScreen } from "../../screens/CompleteScreen";
import { CeremonyConfigProvider } from "@/hooks/useCeremonyConfig";
const state = (status: string): ParticipantActivity => ({state: {ceremonyId: "test", participantId: "test", lease: null, queue: null,
  submission: {submissionId: "s", state: status, ...(status === "ACCEPTED" ? {receiptId: "r"} : {})}}, receipts: []});
const render = (activity: ParticipantActivity, props: Partial<React.ComponentProps<typeof ParticipantActivityCard>> = {}) =>
  renderToStaticMarkup(<ParticipantActivityCard activity={activity} onViewProgress={() => {}} onContinue={() => {}} onReceipt={() => {}} {...props} />);
describe("participant contribution view", () => {
  it("does not claim local computation or cleanup when viewing a recovered receipt", () => {
    const html = renderToStaticMarkup(<CeremonyConfigProvider><CompleteScreen recovered receipts={[]} onRestart={() => {}} onVerify={() => {}} /></CeremonyConfigProvider>);
    expect(html).not.toContain("Contribution generated locally");
    expect(html).not.toContain("Worker stopped");
    expect(html).not.toContain("Temporary files removed");
  });
  it("offers read-only rejoining of pending verification", () => {
    const html = render(state("VERIFYING"));
    expect(html).toContain("View contribution progress"); expect(html).toContain("The server is checking your contribution.");
    expect(html).not.toContain("Claim my slot");
  });
  it("shows the receipt plainly and offers the bunny only when collectibles are on", () => {
    const receipt = {receiptId: "r", circuitId: "social-login", contributionIndex: 2, contributionHash: "5f65404aebbb7514",
      timestamp: Date.parse("2026-10-26T16:21:44Z"), signedReceipt: {payload: {participantPseudonym: "deva-arun"}}} as ReceiptResponse;
    const page = (enabled: boolean) => renderToStaticMarkup(<CeremonyConfigProvider>
      <CompleteScreen collectiblesEnabled={enabled} receipts={[receipt]} onRestart={() => {}} onVerify={() => {}} />
    </CeremonyConfigProvider>);
    const off = page(false);
    expect(off).toMatch(/#2 <span[^>]*>deva-arun<\/span>/); expect(off).toContain("Accepted Oct 26, 16:21 UTC");
    expect(off.indexOf("Share on X")).toBeLessThan(off.indexOf("Download receipt"));
    expect(off).not.toContain("Copy receipt");
    expect(off).not.toContain("social-login"); expect(off).not.toContain("Mint a bunny");
    expect(page(true)).toContain("Mint a bunny");
  });
  it("does not label unsigned acceptance or an unknown state as success", () => {
    expect(participantActivityStage(state("ACCEPTED"))).toBe("unconfirmed");
    expect(participantActivityStage(state("UNKNOWN"))).toBe("unconfirmed");
    expect(render(state("ACCEPTED"))).not.toContain("was accepted");
  });
  it("shows verified past receipts and acceptance timestamps", () => {
    const activity = state("ACCEPTED");
    activity.receipts = [{receiptId: "r", contributionIndex: 1, timestamp: Date.parse("2026-09-28T12:00:00Z")} as ReceiptResponse];
    const html = render(activity);
    expect(html).toContain("was accepted"); expect(html).toContain("Contribution #1"); expect(html).toContain("View receipt");
    expect(html).toContain('dateTime="2026-09-28T12:00:00.000Z"');
  });
  it("distinguishes a failed submission from a still-running computation", () => {
    expect(render(state("REJECTED"))).toContain("ended without acceptance");
    const activity = state("VERIFYING"); activity.state.submission = null;
    activity.state.lease = {state: "ACTIVE"} as NonNullable<ParticipantActivity["state"]["lease"]>;
    const html = render(activity);
    expect(html).toContain("Checking your earlier attempt");
    expect(html).not.toContain("<button");
  });
  it("never offers to resume a reserved slot", () => {
    const activity = state("VERIFYING"); activity.state.submission = null;
    activity.state.lease = {state: "ACTIVE"} as NonNullable<ParticipantActivity["state"]["lease"]>;
    for (const abandoned of [null, "running", "unknown"] as const) {
      const html = render(activity, { abandoned });
      expect(html).not.toMatch(/resume/i);
      expect(html).not.toContain("<button");
    }
    expect(render(activity, { abandoned: "running" })).toContain("running in another tab");
    expect(render(activity, { abandoned: "unknown" })).toContain("released within about 5 minutes");
  });
  it("says when the previous attempt was cancelled because its page closed", () => {
    const empty: ParticipantActivity = { ...state("REJECTED"), state: { ...state("REJECTED").state, submission: null } };
    expect(render(empty)).toBe("");
    const html = render(empty, { closedNotice: true });
    expect(html).toContain(CLOSED_ATTEMPT_NOTICE);
    expect(CLOSED_ATTEMPT_NOTICE).toBe("Your previous attempt was cancelled when the page closed. You can join the queue again.");
    // A newer attempt replaces the notice.
    const queued = { ...empty, state: { ...empty.state, queue: { ticketId: "t", status: "QUEUED", position: 1, offer: null } } };
    expect(render(queued, { closedNotice: true })).not.toContain(CLOSED_ATTEMPT_NOTICE);
    expect(render(queued, { closedNotice: true })).toContain("Return to the queue");
  });
});
