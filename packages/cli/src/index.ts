import { verifyReceiptCommand, type VerifyReceiptOptions } from "./commands/verify-receipt.js";
import process from "node:process";

import { Command } from "commander";

import { statusCommand } from "./commands/status.js";
import { contributeCommand } from "./commands/contribute.js";

const program = new Command();

program
  .name("moss-ceremony")
  .description("Independent CLI contributor for the MOSS Groth16 Phase 2 ceremony")
  .version("0.1.0");

program
  .command("status")
  .description("Verify and show signed ceremony status")
  .argument("<url>", "Coordinator origin or full /v1/ceremonies/<slug> URL")
  .option("--slug <slug>", "Ceremony slug when <url> is only the coordinator origin")
  .requiredOption("--manifest-root-key <path>", "Pinned Ed25519 manifest-root public key")
  .option("--allow-rehearsal", "Accept a signed rehearsal manifest (never for production)")
  .option("--allow-development-manifest", "Allow reduced local-only manifest policy")
  .action(async (url: string, opts: { slug?: string; manifestRootKey: string; allowDevelopmentManifest?: boolean; allowRehearsal?: boolean }) => {
    try {
      await statusCommand(url, opts);
    } catch (error) {
      printError(error);
      process.exitCode = 1;
    }
  });

program
  .command("contribute")
  .description("Contribute to a ceremony")
  .argument("<url>", "Coordinator origin or full /v1/ceremonies/<slug> URL")
  .option("--slug <slug>", "Ceremony slug when <url> is only the coordinator origin")
  .requiredOption("--manifest-root-key <path>", "Pinned Ed25519 manifest-root public key")
  .option("--allow-rehearsal", "Accept a signed rehearsal manifest (never for production)")
  .option("--allow-development-manifest", "Allow reduced local-only manifest policy")
  .option("--auth-url <url>", "Web origin that exposes the GitHub device-auth endpoint")
  .option("--token-file <path>", "Read a coordinator-compatible EdDSA JWT from a mode-0600 file")
  .option("--token <jwt>", "Use a coordinator-compatible EdDSA JWT (less safe than --token-file)")
  .action(
    async (
      url: string,
      opts: {
        slug?: string;
        manifestRootKey: string;
        authUrl?: string;
        tokenFile?: string;
        token?: string;
        allowDevelopmentManifest?: boolean; allowRehearsal?: boolean;
      },
    ) => {
      try {
        await contributeCommand(url, opts);
      } catch (error) {
        printError(error);
        process.exitCode = 1;
      }
    },
  );

program
  .command("verify-receipt")
  .description("Verify a saved receipt offline against the ceremony signing key or a root-signed manifest")
  .argument("<file>", "CLI, browser, or raw signed receipt JSON")
  .option("--signing-key <path>", "Ceremony signing public key published on the ceremony site")
  .option("--ceremony-id <id>", "Expected ceremony ID, published with the signing key")
  .option("--manifest <path>", "Signed manifest JSON (instead of --signing-key)")
  .option("--manifest-root-key <path>", "Independently pinned Ed25519 root public key")
  .option("--slug <slug>", "Expected ceremony slug")
  .option("--allow-rehearsal", "Accept a signed rehearsal manifest (never for production)")
  .option("--allow-development-manifest", "Explicitly accept reduced development policy")
  .action(async (file: string, options: VerifyReceiptOptions) => {
    try { await verifyReceiptCommand(file, options); }
    catch (error) { printError(error); process.exitCode = 1; }
  });

program.parseAsync().then(() => {
  process.exit(process.exitCode ?? 0);
});

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
}
