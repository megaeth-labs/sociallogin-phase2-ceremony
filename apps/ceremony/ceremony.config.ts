import { defaultCopy } from "./src/copy";

export type {
  CeremonyCircuitConfig,
  CeremonyConfig,
  CeremonyCopy,
  CeremonyTierConfig,
  CircuitArtifactsConfig,
  ClientCeremonyConfig,
  ClientCircuitConfig,
  TierId,
} from "./src/types/ceremony";

import type {
  CeremonyConfig,
  ClientCeremonyConfig,
} from "./src/types/ceremony";

export function getCeremonyConfig(): CeremonyConfig {
  return ceremonyConfig;
}

export function getClientConfig(): ClientCeremonyConfig {
  const { circuits, ...rest } = ceremonyConfig;
  return {
    ...rest,
    circuits: circuits.map(({ artifacts, ...circuit }) => circuit),
  };
}

const CIRCUITS_DIR = "circuits";
const PTAU_PATH = `${CIRCUITS_DIR}/pot_final.ptau`;

export const ceremonyConfig: CeremonyConfig = {
  name: "MOSS zkLogin Phase 2 Ceremony",
  slug: "moss-zklogin-phase2",
  description:
    "Add private randomness to the production Groth16 parameters for the remediated MOSS Google zkLogin relation.",
  targetContributions: 100,
  endDate: null,
  // The persistent coordinator owns production leases. This longer value keeps
  // the inherited Cabure development route usable for full-size benchmarks.
  queueTimeoutSeconds: 5400,
  // Production always pairing-verifies contributions regardless of this flag;
  // it only disables the check in dev / CI.
  verifyContributions: false,
  tiersEnabled: false,
  tiers: [],
  circuits: [
    {
      id: "social-login",
      label: "MOSS Google zkLogin",
      description: "The remediated Google RS256 zkLogin relation used by MOSS V4.",
      constraints: "pending clean R1CS verification",
      targetContributions: 100,
      artifacts: {
        r1csPath: "circuits/jwt-tx-validation.r1cs",
        ptauPath: PTAU_PATH,
      },
    },
  ],
  branding: {
    shortName: "MOSS",
    accentColor: "#95C23A",
  },
  storage: {
    manifestPath: "ceremony:manifest",
    circuitStatePrefix: "ceremony:circuits",
    receiptsPath: "ceremony:receipts",
    participantContributionsPrefix: "ceremony:contributions:participants",
    participantsIndexPath: "ceremony:contributions:participants:index",
    zkeyPrefix: "moss-zklogin-phase2/zkeys",
  },
  copy: defaultCopy,
};
