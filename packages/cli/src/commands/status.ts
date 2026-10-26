import { CeremonyClient, parseCoordinatorTarget } from "../client.js";
import { loadTrustedCeremonyState } from "../ceremony-state.js";

export interface StatusOptions {
  slug?: string;
  manifestRootKey: string;
  allowDevelopmentManifest?: boolean; allowRehearsal?: boolean;
}

export async function statusCommand(rawUrl: string, options: StatusOptions): Promise<void> {
  const target = parseCoordinatorTarget(rawUrl, options.slug);
  if (options.allowDevelopmentManifest && target.production) {
    throw new Error("Development manifests are allowed only on a localhost coordinator URL.");
  }
  const client = new CeremonyClient(target);
  const trusted = await loadTrustedCeremonyState(client, options.manifestRootKey, options);
  const { manifest, status, checkpoint } = trusted;

  console.log(`\nCeremony:  ${target.ceremonyUrl}`);
  console.log(`State:     ${status.state}`);
  console.log(
    `Progress:  ${status.generation} / ${manifest.contributionPolicy.targetContributions} contributions`,
  );
  console.log(`Queue:     ${status.queueDepth}`);
  console.log(`Head:      ${status.head.sha256}`);
  console.log(`Bytes:     ${status.head.byteLength}`);
  console.log(`Checkpoint revision: ${checkpoint.revision}`);
  console.log(`Checkpoint expires:  ${checkpoint.expiresAt}`);
  console.log(`Seals at:             ${manifest.schedule.sealsAt}`);
  console.log("Signatures: manifest root and coordinator checkpoint verified\n");
}
