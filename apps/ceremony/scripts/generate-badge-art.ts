// Writes the onchain bunny artwork library from the web generator's tables.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BADGE_ART_SOL_PATH, badgeArtSolidity } from "../src/lib/nft/badge-art-sol";

const target = resolve(__dirname, "../../..", BADGE_ART_SOL_PATH);
writeFileSync(target, badgeArtSolidity());
console.log(`wrote ${target}`);
