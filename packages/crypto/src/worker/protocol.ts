export enum RequestType {
  Contribute = "contribute",
  ContributeOpfs = "contributeOpfs",
  GenerateEntropy = "generateEntropy",
}

export enum ResponseType {
  Result = "result",
  OpfsResult = "opfsResult",
  Entropy = "entropy",
  Error = "error",
  Progress = "progress",
}

export type OpfsZkeySource =
  | {
      kind: "download";
      /** CORS-enabled, preferably short-lived presigned artifact URL. */
      url: string;
      expectedSize: number;
      /** Exact SHA-256 committed by the coordinator (`0x` + 64 hex chars). */
      expectedSha256: string;
    }
  | {
      kind: "opfs";
      file: FileSystemFileHandle;
      expectedSize: number;
      expectedSha256: string;
    };

/** Messages sent TO the worker */
export type WorkerRequest =
  | {
      type: RequestType.Contribute;
      prevZkey: Uint8Array;
      entropy: Uint8Array;
      name?: string;
    }
  | {
      /** Bounded-memory production path; never transfers a complete zkey. */
      type: RequestType.ContributeOpfs;
      artifactFormat?: "zkey" | "bellman";
      /** User chose to attempt actual I/O despite a failed advisory probe. */
      overrideFailedCheck?: boolean;
      source: OpfsZkeySource;
      entropy: Uint8Array;
      name?: string;
    }
  | {
      type: RequestType.GenerateEntropy;
    };

/** Messages sent FROM the worker */
export type WorkerResponse =
  | {
      type: ResponseType.Result;
      newZkey: Uint8Array;
      /** snarkjs contribution hash (Blake2b over the contribution pubkey). */
      contributionHash: string;
      /** SHA-256 of the new zkey binary. */
      zkeyHash: string;
    }
  | {
      type: ResponseType.OpfsResult;
      /** Cloneable OPFS handle; upload with `file.getFile().stream()`. */
      outputFile: FileSystemFileHandle;
      /** Entry to remove with `removeBrowserContributionFile` after upload. */
      outputFileName: string;
      outputSize: number;
      contributionHash: string;
      zkeyHash: string;
    }
  | {
      type: ResponseType.Entropy;
      data: Uint8Array;
    }
  | {
      type: ResponseType.Error;
      message: string;
      code?: string;
    }
  | {
      type: ResponseType.Progress;
      stage: string;
      percent: number;
    };
