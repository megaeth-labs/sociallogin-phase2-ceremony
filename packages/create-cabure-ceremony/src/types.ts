/**
 * Collected answers from the interactive wizard prompts.
 *
 * @property projectName - Display name for the ceremony UI
 * @property targetContributions - Desired number of contributions before finalization
 * @property endDate - Optional ceremony deadline in YYYY-MM-DD format, or null if open-ended
 * @property circuitArtifactsPath - Resolved absolute path to circuit artifacts directory, or null if skipped
 */
export interface WizardAnswers {
  projectName: string;
  targetContributions: number;
  endDate: string | null;
  circuitArtifactsPath: string | null;
}

export type TierId = "core" | "popular" | "all";

/**
 * Tier grouping shown on the tier selection screen.
 * Each tier maps to a subset of circuit IDs and an estimated time.
 */
export interface GeneratedTierConfig {
  id: TierId;
  label: string;
  description: string;
  estimatedMinutes: number;
  circuitIds: string[];
}

/**
 * Configuration for a single circuit in the generated ceremony project.
 * Matches the CeremonyCircuitConfig shape expected by the ceremony-ui templates.
 */
export interface GeneratedCircuitConfig {
  id: string;
  label: string;
  description: string;
  constraints: string;
  targetContributions: number;
  artifacts: {
    r1csPath: string;
    ptauPath: string;
  };
}

/**
 * Full context passed to the project scaffolder.
 *
 * @property outputDirectory - Absolute path where the project will be generated
 * @property projectName - Human-readable project name
 * @property projectSlug - URL-safe kebab-case project identifier
 * @property targetContributions - Per-circuit target (applied uniformly by wizard)
 * @property endDate - Optional deadline (YYYY-MM-DD) or null
 * @property circuits - List of circuit configurations to embed in ceremony.config.ts
 * @property tiers - Tier definitions generated from circuit discovery
 * @property stateManifestBlobUrl - URL for the ceremony state manifest blob
 */
export interface ScaffoldContext {
  outputDirectory: string;
  projectName: string;
  projectSlug: string;
  targetContributions: number;
  endDate: string | null;
  circuits: GeneratedCircuitConfig[];
  tiers: GeneratedTierConfig[];
  stateManifestBlobUrl: string;
}
