// Child-process fixture generator: snarkjs keeps worker threads alive, so the
// test runner never imports it directly. Writes genesis.zkey and its Bellman
// export genesis.params for the multiplier test circuit into DIRECTORY.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [directory] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../crypto/tests/fixtures");
const { zKey } = createRequire(join(here, "../package.json"))("snarkjs");

console.log = () => {};
await zKey.newZKey(join(fixtures, "multiplier.r1cs"), join(fixtures, "pot_final.ptau"), join(directory, "genesis.zkey"));
await zKey.exportBellman(join(directory, "genesis.zkey"), join(directory, "genesis.params"));
process.exit(0);
