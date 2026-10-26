/** The walkthrough's steps, in order. Shared by How it works and the homepage tile. */
export const WALKTHROUGH_STEPS = [
  { id: "join", short: "Join", title: "Sign in and join the queue" },
  { id: "download", short: "Download", title: "Download the latest accepted file" },
  { id: "randomness", short: "Randomness", title: "Add your randomness" },
  { id: "compute", short: "Compute", title: "Compute your contribution locally" },
  { id: "upload", short: "Upload", title: "Upload the new file" },
  { id: "verify", short: "Verify", title: "Checked before it counts" },
  { id: "receipt", short: "Receipt", title: "A signed receipt, and the chain moves on" },
  { id: "close", short: "Close", title: "Contributions close" },
  { id: "beacon", short: "Beacon", title: "Sealed with a public beacon" },
  { id: "publish", short: "Publish", title: "Final key verified and published" },
] as const;

export type WalkthroughStepId = (typeof WALKTHROUGH_STEPS)[number]["id"];

export function walkthroughStep(id: WalkthroughStepId) {
  return WALKTHROUGH_STEPS.find((step) => step.id === id)!;
}
