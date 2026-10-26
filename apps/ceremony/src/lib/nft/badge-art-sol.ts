import {
  ART_CLOSE,
  ART_OPEN,
  type Art,
  type Frag,
  FOOTER_CLOSE,
  FOOTER_OPEN,
  FOOTER_TEXT,
  FUR_TONE,
  LIFT,
  RECEIPT_TEXT,
  SHARED_ART,
  SVG_OPEN,
  TRAITS,
  type Trait,
  type TraitKey,
} from "./badge-svg";

/**
 * Emits packages/contribution-nft/src/BadgeArt.sol from the same tables that
 * draw the web preview. Run `pnpm --filter @moss/phase2-ceremony-web
 * generate:badge-art` after changing the art; badge-svg.test.ts fails while
 * the committed library is stale.
 */
export const BADGE_ART_SOL_PATH = "packages/contribution-nft/src/BadgeArt.sol";

function literal(text: string): string {
  if (/[^\x20-\x7e]|'|\\/.test(text))
    throw new Error(`Badge art must be printable ASCII without quotes or backslashes: ${text.slice(0, 40)}`);
  return `'${text}'`;
}

const title = (key: string) => key[0].toUpperCase() + key.slice(1);

/** Shared fragments are emitted once as private functions and called from each option. */
const fragFn = (frag: Frag) => `_${frag.name}`;

/** A Solidity expression for one option: a literal, or string.concat over segments (nested in eights). */
function expression(art: Art): string {
  if (typeof art === "string") return literal(art);
  const parts = art.map((seg) => (typeof seg === "string" ? literal(seg) : `${fragFn(seg)}()`));
  const concat = (items: string[]): string =>
    items.length <= 8
      ? `string.concat(${items.join(", ")})`
      : concat(Array.from({ length: Math.ceil(items.length / 8) }, (_, i) => concat(items.slice(i * 8, i * 8 + 8))));
  return parts.length === 1 ? parts[0] : concat(parts);
}

function choose(name: string, values: Art[]): string {
  const branches = values
    .slice(0, -1)
    .map((value, i) => `        if (t == ${i}) return ${expression(value)};`)
    .join("\n");
  return `    function ${name}(uint256 t) internal pure returns (string memory) {
${branches ? `${branches}\n` : ""}        return ${expression(values[values.length - 1])};
    }`;
}

function fragments(): string {
  const seen = new Map<string, string>();
  const arts = Object.values(TRAITS).flatMap((trait) => [...trait.art, ...(trait.front ?? []), ...(trait.mouth ?? [])]);
  for (const art of arts)
    if (typeof art !== "string")
      for (const seg of art)
        if (typeof seg !== "string") {
          const prior = seen.get(seg.name);
          if (prior !== undefined && prior !== seg.text) throw new Error(`Fragment ${seg.name} has two texts`);
          seen.set(seg.name, seg.text);
        }
  return [...seen].map(
    ([name, text]) => `    function _${name}() private pure returns (string memory) {
        return ${literal(text)};
    }`,
  ).join("\n\n");
}

function picker(key: TraitKey, trait: Trait, byte: number): string {
  let total = 0;
  const steps = trait.weights.slice(0, -1).map((weight, i) => {
    total += weight;
    return `        if (b < ${total}) return ${i};`;
  });
  return `    /// @dev ${trait.label}: byte ${byte} of the receipt hash, weights ${trait.weights.join("/")} of 256.
    function pick${title(key)}(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> ${248 - 8 * byte}) & 0xff;
${steps.join("\n")}
        return ${trait.weights.length - 1};
    }`;
}

export function badgeArtSolidity(): string {
  const keys = Object.keys(TRAITS) as TraitKey[];
  const sections = keys.flatMap((key, byte) => {
    const trait = TRAITS[key];
    const out = [
      picker(key, trait, byte),
      choose(`${key}Art`, trait.art),
      choose(`${key}Name`, trait.names),
    ];
    if (trait.front) out.push(choose(`${key}Front`, trait.front));
    if (trait.mouth) out.push(choose(`${key}Mouth`, trait.mouth));
    return out;
  });
  const attributes = keys
    .map(
      (key) =>
        `'{"trait_type":"${TRAITS[key].label}","value":"', ${key}Name(pick${title(key)}(receipt)), '"}'`,
    )
    .join(",\n            ',',\n            ");
  return `// SPDX-License-Identifier: MIT
// Generated from apps/ceremony/src/lib/nft/badge-svg.ts by badge-art-sol.ts. Do not edit by hand.
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Bunny collectible artwork: traits read from the receipt hash, the full hash drawn as a strip.
library BadgeArt {
    using Strings for uint256;

${sections.join("\n\n")}

    /// @dev 1 when the glass needs the lifting haze over its background (dark glass), else 0.
    function furTone(uint256 fur) internal pure returns (uint256) {
${FUR_TONE.map((tone, i) => (tone ? `        if (fur == ${i}) return 1;` : "")).filter(Boolean).join("\n")}
        return 0;
    }

    /// @dev The background behind the bunny, hazed for dark glass so it separates from it.
    function backdrop(uint256 receipt) internal pure returns (string memory) {
        string memory art = backgroundArt(pickBackground(receipt));
        return furTone(pickFur(receipt)) == 1 ? string.concat(art, ${literal(LIFT)}) : art;
    }

${fragments()}

    /// @dev Background, glass, ears, body, outfit and head: drawn by BadgeRenderer.
    function figure(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            backdrop(receipt),
            furArt(pickFur(receipt)),
            earsArt(pickEars(receipt)),
            ${literal(SHARED_ART.BODY)},
            outfitArt(pickOutfit(receipt)),
            ${literal(SHARED_ART.HEAD)},
            earsFront(pickEars(receipt))
        );
    }

    /// @dev Markings, eyes, nose, the signal's mouth and accessories: drawn by BadgeFaceRenderer.
    function face(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            markingArt(pickMarking(receipt)),
            eyesArt(pickEyes(receipt)),
            ${literal(SHARED_ART.FACE)},
            signalMouth(pickSignal(receipt)),
            neckwearArt(pickNeckwear(receipt)),
            headwearArt(pickHeadwear(receipt)),
            eyeColorArt(pickEyeColor(receipt))
        );
    }

    /// @dev The full SVG around a drawn figure and face (grouped for the signal layer), with the hash strip and caption.
    function frame(uint256 receipt, uint256 index, string memory figure_, string memory face_)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            ${literal(SVG_OPEN + ART_OPEN)},
            figure_,
            face_,
            ${literal(ART_CLOSE)},
            signalArt(pickSignal(receipt)),
            ${literal(FOOTER_OPEN)},
            bitPath(receipt),
            ${literal(FOOTER_TEXT)},
            index.toString(),
            ${literal(RECEIPT_TEXT)},
            shortReceipt(receipt),
            ${literal(FOOTER_CLOSE)}
        );
    }

    /// @dev OpenSea attribute objects, comma separated, for the metadata attributes array.
    function attributes(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            ${attributes}
        );
    }

    /// @dev 0x1234abcd...ef567890
    function shortReceipt(uint256 receipt) internal pure returns (string memory) {
        bytes memory full = bytes(receipt.toHexString(32));
        bytes memory out = new bytes(21);
        for (uint256 i; i < 10; ++i) out[i] = full[i];
        out[10] = "."; out[11] = "."; out[12] = ".";
        for (uint256 i; i < 8; ++i) out[13 + i] = full[58 + i];
        return string(out);
    }

    /// @dev One 3x3 cell per set bit, most significant first, two rows of 128.
    function bitPath(uint256 receipt) internal pure returns (string memory) {
        bytes memory out = new bytes(256 * 16);
        uint256 n;
        for (uint256 i; i < 256; ++i) {
            if ((receipt >> (255 - i)) & 1 == 0) continue;
            out[n++] = "M";
            n = _digits(out, n, 64 + (i % 128) * 4);
            out[n++] = " ";
            n = _digits(out, n, i < 128 ? 572 : 576);
            bytes8 cell = "h3v3h-3z";
            for (uint256 j; j < 8; ++j) out[n++] = cell[j];
        }
        assembly {
            mstore(out, n)
        }
        return string(out);
    }

    function _digits(bytes memory out, uint256 n, uint256 value) private pure returns (uint256) {
        if (value >= 100) out[n++] = bytes1(uint8(48 + value / 100));
        if (value >= 10) out[n++] = bytes1(uint8(48 + (value / 10) % 10));
        out[n++] = bytes1(uint8(48 + value % 10));
        return n;
    }
}
`;
}
