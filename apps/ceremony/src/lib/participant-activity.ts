import type { ParticipantActivity } from "./api";

export function participantActivityStage(activity: ParticipantActivity) {
  const submission = activity.state.submission;
  if (submission?.state === "ACCEPTED") {
    return activity.receipts.some((receipt) => receipt.receiptId === submission.receiptId)
      ? "accepted" : "unconfirmed";
  }
  if (submission && ["SUBMITTED", "VERIFYING", "PENDING"].includes(submission.state)) return "pending";
  if (submission && ["REJECTED", "STALE", "EXPIRED", "CANCELLED"].includes(submission.state)) return "failed";
  if (submission) return "unconfirmed";
  if (activity.state.lease?.state === "ACTIVE") return "active";
  if (activity.state.queue && ["QUEUED", "OFFERED"].includes(activity.state.queue.status)) return "queued";
  return "empty";
}
