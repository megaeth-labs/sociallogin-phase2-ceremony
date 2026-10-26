import {
  RequestType,
  ResponseType,
  type WorkerResponse,
} from "@wonderland/cabure-crypto/protocol";

export interface ContributionResult {
  outputFile: FileSystemFileHandle;
  outputFileName: string;
  outputSize: number;
  contributionHash: string;
  zkeyHash: string;
}

export type ContributionStage =
  | "download"
  | "validate"
  | "compute"
  | "hash"
  | "done";

/**
 * Run the production-sized contribution entirely in a dedicated worker with
 * OPFS-backed input and output. No complete zkey is copied through JS heap or
 * postMessage.
 */
export async function runContribution(options: {
  overrideFailedCheck?: boolean;
  artifactFormat?: "zkey" | "bellman";
  predecessorUrl: string;
  predecessorSize: number;
  predecessorSha256: string;
  entropy: Uint8Array;
  name?: string;
  onProgress?: (stage: ContributionStage, percent: number) => void;
  signal?: AbortSignal;
}): Promise<ContributionResult> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("@wonderland/cabure-crypto/worker", import.meta.url),
      { type: "module" },
    );

    const cleanup = () => {
      worker.terminate();
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Contribution cancelled.", "AbortError"));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === ResponseType.Progress) {
        options.onProgress?.(
          message.stage as ContributionStage,
          message.percent,
        );
        return;
      }

      if (message.type === ResponseType.OpfsResult) {
        cleanup();
        resolve({
          outputFile: message.outputFile,
          outputFileName: message.outputFileName,
          outputSize: message.outputSize,
          contributionHash: message.contributionHash,
          zkeyHash: message.zkeyHash,
        });
        return;
      }

      if (message.type === ResponseType.Error) {
        cleanup();
        const error = new Error(message.message) as Error & { code?: string };
        error.code = message.code;
        reject(error);
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };

    const entropy = options.entropy.slice();
    worker.postMessage(
      {
        type: RequestType.ContributeOpfs,
        artifactFormat: options.artifactFormat,
        overrideFailedCheck: options.overrideFailedCheck === true,
        source: {
          kind: "download",
          url: options.predecessorUrl,
          expectedSize: options.predecessorSize,
          expectedSha256: options.predecessorSha256,
        },
        entropy,
        name: options.name,
      },
      [entropy.buffer],
    );
  });
}
