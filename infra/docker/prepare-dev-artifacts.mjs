import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureRoot = join(root, "packages", "crypto", "tests", "fixtures");
const outputRoot = join(root, "infra", "dev-artifacts");
const outputs = {
  r1cs: join(outputRoot, "circuit.r1cs"),
  ptau: join(outputRoot, "powersoftau.ptau"),
  genesis: join(outputRoot, "genesis.zkey"),
};

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
for (const path of Object.values(outputs)) {
  if (await exists(path)) {
    throw new Error(
      "development artifact output already exists; preserve it or remove all " +
        "three ignored files before intentionally creating a fresh local epoch",
    );
  }
}

try {
  await copyFile(join(fixtureRoot, "multiplier.r1cs"), outputs.r1cs);
  await copyFile(join(fixtureRoot, "pot_final.ptau"), outputs.ptau);
  await run("pnpm", [
    "--filter",
    "@moss/phase2-finalizer",
    "exec",
    "snarkjs",
    "groth16",
    "setup",
    outputs.r1cs,
    outputs.ptau,
    outputs.genesis,
  ]);
  process.stdout.write(
    "Created ignored synthetic development artifacts in infra/dev-artifacts.\n",
  );
} catch (error) {
  await Promise.all(
    Object.values(outputs).map((path) => rm(path, { force: true })),
  );
  throw error;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `development setup failed (${code ?? signal ?? "unknown"})`,
          ),
        );
      }
    });
  });
}
