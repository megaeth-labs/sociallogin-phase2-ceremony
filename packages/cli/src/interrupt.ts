/**
 * What an interrupt should do depends on how far the attempt has got:
 * - "idle": nothing is held yet, so exit at once;
 * - "waiting": a queue ticket or an unclaimed offer exists, so leave the queue
 *   and let the next person in;
 * - "leased": a claim has been sent or accepted. Cancelling could discard a
 *   slot the participant can still resume, so leave it reserved.
 */
export type InterruptPhase = "idle" | "waiting" | "leased";

const LEAVE_TIMEOUT_MS = 5_000;

export interface QueueInterruptOptions {
  phase(): InterruptPhase;
  leaveQueue(): Promise<void>;
  /** Forget the queue ticket locally so a rerun joins afresh. */
  forgetQueue(): Promise<void>;
  log(message: string): void;
  exit(code: number): void;
  timeoutMs?: number;
}

export function exitCodeFor(signal: NodeJS.Signals): number {
  return signal === "SIGTERM" ? 143 : 130;
}

/**
 * Returns the signal handler. A second interrupt exits immediately, without
 * waiting for an outstanding leave request.
 */
export function queueInterruptHandler(options: QueueInterruptOptions): (signal: NodeJS.Signals) => Promise<void> {
  let interrupted = false;
  return async (signal) => {
    const code = exitCodeFor(signal);
    if (interrupted) {
      options.exit(code);
      return;
    }
    interrupted = true;
    const phase = options.phase();
    if (phase === "leased") {
      options.log("\nInterrupted. Your slot stays reserved until it lapses; run the same command again to resume it.");
      options.exit(code);
      return;
    }
    if (phase === "idle") {
      options.exit(code);
      return;
    }
    options.log("\nInterrupted. Leaving the queue...");
    try {
      await withTimeout(options.leaveQueue(), options.timeoutMs ?? LEAVE_TIMEOUT_MS);
      options.log("Left the queue. Run the command again to rejoin at the end of the line.");
    } catch {
      options.log("Could not confirm leaving the queue. If your turn comes while you are away, the offer lapses after two minutes.");
    }
    await options.forgetQueue().catch(() => undefined);
    options.exit(code);
  };
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("leave request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
