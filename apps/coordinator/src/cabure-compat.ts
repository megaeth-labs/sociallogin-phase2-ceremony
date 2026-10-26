export interface CabureStatusResponse {
  name: string;
  isActive: boolean;
  circuits: Array<{
    circuitId: string;
    name: string;
    currentContributions: number;
    targetContributions: number;
    isComplete: boolean;
  }>;
  tiers: Array<{ id: string; name: string; circuitIds: string[] }>;
}

/** Read-only adapter for the legacy Cabure status screen. */
export function toCabureStatus(input: {
  name: string;
  state: string;
  generation: number;
  targetContributions: number;
}): CabureStatusResponse {
  const circuitId = "google-rs256-zksync-v3";
  return {
    name: input.name,
    isActive: input.state === "OPEN",
    circuits: [{
      circuitId,
      name: "MOSS Google RS256 zkLogin",
      currentContributions: input.generation,
      targetContributions: input.targetContributions,
      isComplete: input.state !== "OPEN" || input.generation >= input.targetContributions,
    }],
    tiers: [{ id: "moss", name: "MOSS", circuitIds: [circuitId] }],
  };
}

export const CABURE_ROUTE_MAPPING = Object.freeze({
  "/api/ceremony/status": "GET /v1/ceremonies/:slug/status",
  "/api/ceremony/queue": "POST|GET /v1/ceremonies/:slug/queue[|/me]",
  "/api/ceremony/circuits/:id/zkey": "GET /v1/ceremonies/:slug/status then head.downloadUrl",
  "/api/ceremony/circuits/:id/upload": "POST /v1/leases/:leaseId/uploads",
  "/api/ceremony/circuits/:id/contribute": "POST /v1/leases/:leaseId/submit",
});
