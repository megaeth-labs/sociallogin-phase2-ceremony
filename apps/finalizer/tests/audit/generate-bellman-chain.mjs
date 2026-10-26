// Child-process fixture generator: snarkjs keeps worker threads alive, so the
// test runner never imports it directly. Writes 0.params (the exported
// genesis) through COUNT.params into DIRECTORY.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [directory, countText] = process.argv.slice(2);
const count = Number(countText);
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../../packages/crypto/tests/fixtures");
const require = createRequire(join(here, "../../package.json"));
const { zKey } = require("snarkjs");
const { buildBn128 } = createRequire(require.resolve("snarkjs"))("ffjavascript");

console.log = () => {};
const curve = await buildBn128();
const genesis = join(directory, "genesis.zkey");
await zKey.newZKey(join(fixtures, "multiplier.r1cs"), join(fixtures, "pot_final.ptau"), genesis);
await zKey.exportBellman(genesis, join(directory, "0.params"));
for (let index = 1; index <= count; index += 1) {
  await zKey.bellmanContribute(curve, join(directory, `${index - 1}.params`), join(directory, `${index}.params`), randomBytes(64).toString("hex"));
}
process.exit(0);
