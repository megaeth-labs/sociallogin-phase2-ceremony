import { zKey } from "snarkjs";
// Kept isolated: exporting the basis starts ffjavascript workers.
console.log = () => {};
void zKey.exportBellman(process.argv[2]!, process.argv[3]!).then(
  () => process.exit(0), () => process.exit(1),
);
