/**
 * Web Worker entry point for contribute(). Runs snarkjs contribution in a
 * dedicated thread to avoid blocking the UI. Message protocol is defined by
 * `WorkerRequest` and `WorkerResponse` in `./protocol.ts`.
 *
 * Toxic-waste hygiene: entropy passes through immutable JS strings on its
 * way into snarkjs and cannot be fully erased. The handler zeros the input
 * buffer after the result is posted, but for full hygiene the consumer
 * should terminate the worker as soon as the result has been transferred.
 */

import {
  RequestType,
  ResponseType,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";
import { browserContribute } from "./browser-contribute.js";

/**
 * Minimal structural type for the worker scope, so the handler is testable
 * with a plain object instead of mutating `globalThis.self`.
 */
export interface WorkerScope {
  postMessage(
    msg: WorkerResponse,
    options?: { transfer?: Transferable[] },
  ): void;
  onmessage:
    | ((event: MessageEvent<WorkerRequest>) => unknown)
    | null;
}

/**
 * Bind the contribute-worker message handler to a worker-like scope. The real
 * worker entry below calls this once with the global `self`; tests call it
 * with a mock object.
 */
export function attachWorker(target: WorkerScope): void {
  const post = (msg: WorkerResponse, transfer?: Transferable[]) => {
    target.postMessage(msg, { transfer: transfer ?? [] });
  };

  target.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const msg = event.data;

    try {
      switch (msg.type) {
        case RequestType.Contribute: {
          try {
            post({
              type: ResponseType.Progress,
              stage: "computing",
              percent: 0,
            });

            const result = await browserContribute(
              msg.prevZkey,
              msg.entropy,
              msg.name ?? "contributor",
            );

            post({
              type: ResponseType.Progress,
              stage: "done",
              percent: 100,
            });

            post(
              {
                type: ResponseType.Result,
                newZkey: result.zkey,
                contributionHash: result.contributionHash,
                zkeyHash: result.zkeyHash,
              },
              [result.zkey.buffer],
            );
          } finally {
            // Zero the entropy buffer on success and on failure. Pairs with
            // the outer try/catch that turns thrown errors into Error
            // responses; the buffer is wiped before the response is posted.
            msg.entropy.fill(0);
          }
          break;
        }

        case RequestType.ContributeOpfs: {
          try {
            const { runOpfsContributionJob } = await import("./opfs-job.js");
            const result = await runOpfsContributionJob(
              msg.source,
              msg.entropy,
              msg.name ?? "contributor",
              (stage, percent) => {
                post({ type: ResponseType.Progress, stage, percent });
              },
              msg.artifactFormat,
              msg.overrideFailedCheck === true,
            );

            post({
              type: ResponseType.Progress,
              stage: "done",
              percent: 100,
            });
            // FileSystemFileHandle is structured-cloneable but not
            // transferable. Crucially, no complete zkey crosses this boundary.
            post({
              type: ResponseType.OpfsResult,
              outputFile: result.outputFile,
              outputFileName: result.outputFileName,
              outputSize: result.outputSize,
              contributionHash: result.contributionHash,
              zkeyHash: result.zkeyHash,
            });
          } finally {
            msg.entropy.fill(0);
          }
          break;
        }

        case RequestType.GenerateEntropy: {
          const data = new Uint8Array(64);
          crypto.getRandomValues(data);
          post({ type: ResponseType.Entropy, data }, [data.buffer]);
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        typeof err === "object" &&
        err !== null &&
        typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : undefined;
      post({ type: ResponseType.Error, message, code });
    }
  };
}

// Real worker entry. In Node (tests importing this module), `self` is
// undefined and this is a no-op; tests call `attachWorker(mock)` directly.
if (typeof self !== "undefined") {
  attachWorker(self as unknown as WorkerScope);
}
