export interface JobHeartbeatClient {
  heartbeat(jobId: string, signal?: AbortSignal): Promise<string>;
}

export interface ActiveJobHeartbeat {
  signal: AbortSignal;
  assertHealthy(): void;
  stop(): Promise<void>;
}

/**
 * Renew a claimed verifier job while downloads and isolated verification
 * passes run. Any renewal failure aborts the work signal so a stale attempt
 * cannot submit reports after another worker has reclaimed the job.
 */
export async function startJobHeartbeat(input: {
  client: JobHeartbeatClient;
  jobId: string;
  intervalMs: number;
  serviceSignal: AbortSignal;
}): Promise<ActiveJobHeartbeat> {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000) {
    throw new Error("verifier heartbeat interval is invalid");
  }
  const loopController = new AbortController();
  const workController = new AbortController();
  let failure: Error | undefined;
  const abortForService = () => {
    loopController.abort(input.serviceSignal.reason);
    workController.abort(input.serviceSignal.reason);
  };
  if (input.serviceSignal.aborted) abortForService();
  else input.serviceSignal.addEventListener("abort", abortForService, { once: true });

  const requestSignal = AbortSignal.any([
    loopController.signal,
    input.serviceSignal,
  ]);
  try {
    await input.client.heartbeat(input.jobId, requestSignal);
  } catch (error) {
    loopController.abort(error);
    workController.abort(error);
    input.serviceSignal.removeEventListener("abort", abortForService);
    throw error;
  }

  const loop = (async () => {
    try {
      while (!requestSignal.aborted) {
        await abortableDelay(input.intervalMs, requestSignal);
        await input.client.heartbeat(input.jobId, requestSignal);
      }
    } catch (error) {
      if (!requestSignal.aborted) {
        failure = error instanceof Error
          ? error
          : new Error("verifier job heartbeat failed");
        workController.abort(failure);
      }
    }
  })();

  return {
    signal: AbortSignal.any([workController.signal, input.serviceSignal]),
    assertHealthy() {
      if (failure) throw failure;
      input.serviceSignal.throwIfAborted();
    },
    async stop() {
      loopController.abort();
      await loop;
      input.serviceSignal.removeEventListener("abort", abortForService);
    },
  };
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
