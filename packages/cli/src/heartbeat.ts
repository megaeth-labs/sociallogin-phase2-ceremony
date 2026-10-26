import { CeremonyClient } from "./client.js";

export type ContributionStage =
  | "CLAIMED"
  | "DOWNLOADING"
  | "COMPUTING"
  | "UPLOADING"
  | "SUBMITTING";

export class LeaseHeartbeat {
  private progress: Record<string, unknown> = { stage: "CLAIMED" };
  private lastSuccess = 0;
  private lastError: unknown;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly client: CeremonyClient,
    private readonly leaseId: string,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error("Heartbeat interval is invalid.");
    }
  }

  async start(): Promise<void> {
    await this.send();
    this.schedule();
  }

  update(stage: ContributionStage, details: Record<string, unknown> = {}): void {
    this.progress = { stage, ...details };
  }

  async ensureHealthy(): Promise<void> {
    await this.inFlight;
    if (Date.now() - this.lastSuccess > this.intervalMs * 2) {
      try {
        await this.send();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Lease heartbeat is not healthy: ${reason}`);
      }
    }
    if (Date.now() - this.lastSuccess > this.intervalMs * 2) {
      const reason = this.lastError instanceof Error ? this.lastError.message : "no recent acknowledgement";
      throw new Error(`Lease heartbeat is not healthy: ${reason}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.send()
        .catch((error: unknown) => {
          this.lastError = error;
        })
        .finally(() => {
          this.inFlight = undefined;
          this.schedule();
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async send(): Promise<void> {
    await this.client.heartbeat(this.leaseId, {
      ...this.progress,
      observedAt: new Date().toISOString(),
    });
    this.lastSuccess = Date.now();
    this.lastError = undefined;
  }
}
