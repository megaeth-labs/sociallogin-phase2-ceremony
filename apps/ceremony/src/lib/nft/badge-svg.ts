/**
 * Collectible artwork: a frosted-glass bunny portrait in a cyberpunk night,
 * whose traits are read from the receipt hash, with the full hash drawn as a
 * 256-cell strip in the footer.
 *
 * The contract renders the same bytes: packages/contribution-nft/src/BadgeArt.sol
 * is generated from TRAITS below (scripts/generate-badge-art.ts) and both test
 * suites pin BADGE_SVG_FIXTURE_KECCAK. Fragments must stay ASCII with no single
 * quotes so they embed as Solidity string literals.
 *
 * Colours are literal because wallets render the image outside the site CSS.
 * They follow the night moss tokens in globals.css: night oklch(0.19 0.018 165)
 * ≈ #0f1a15, neon oklch(0.87 0.16 158) ≈ #5ff0b1, frost oklch(0.975 0.006 160)
 * ≈ #f5f9f6, haze oklch(0.72 0.11 340) ≈ #d58aac.
 */

/**
 * A shared fragment: emitted once in Solidity as a private function, so colour
 * variants that reuse a template cost only their own parameters on chain.
 */
export type Frag = { name: string; text: string };
export type Seg = string | Frag;
/** One option's artwork: a literal, or segments joined in order. */
export type Art = string | Seg[];

export const flat = (art: Art): string =>
  typeof art === "string" ? art : art.map((seg) => (typeof seg === "string" ? seg : seg.text)).join("");
const frag = (name: string, text: string): Frag => ({ name, text });

export type Trait = {
  /** Shown as the OpenSea trait_type. */
  label: string;
  /** Out of 256: byte value b picks the first option whose running total exceeds b. */
  weights: number[];
  names: string[];
  art: Art[];
  /** Drawn in front of the head (lop ears); same length as art when present. */
  front?: Art[];
  /** Drawn under the nose (the signal's mouth); same length as art when present. */
  mouth?: Art[];
};

const INK = "#13201a";
const NEON = "#5ff0b1";
/** A lit glass edge over the eye, where a drawn bunny would have an ink lid line. */
const RIDGE = '<path d="M246 347q32-20 62 6" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.5" stroke-linecap="round"/>';

/**
 * One almond glass-bead eye at the left position, iris gradient i, under a lid
 * of the coat's glass whose edge catches the light.
 */
const eyeShape = (look = 0, iris = "i") =>
  `<path d="M248 352q28-24 58 0q-29 20-58 0z" fill="${INK}"/><circle cx="${278 + look}" cy="352" r="11" fill="url(#${iris})"/><circle cx="${278 + look}" cy="352" r="4.5" fill="${INK}"/><circle cx="${283 + look}" cy="347" r="3" fill="#fff"/><circle cx="${272 + look}" cy="358" r="1.5" fill="#fff" fill-opacity=".6"/><path d="M244 348q30-30 66 6q-34-22-66-6z" fill="url(#f)"/>${RIDGE}`;
/**
 * A cat eye: the whole almond is iris, split by a vertical slit pupil, with a
 * thin rim and a faint glow in the eye colour (gradients i and k).
 */
const CAT_EYE =
  '<ellipse cx="277" cy="352" rx="38" ry="22" fill="url(#k)" fill-opacity=".11"/>' +
  '<path d="M246 352q31-28 62 0q-31 24-62 0z" fill="url(#i)" stroke="url(#k)" stroke-width="2"/>' +
  `<path d="M277 337q6 15 0 30q-6-15 0-30z" fill="${INK}"/><circle cx="285" cy="345" r="2.6" fill="#fff"/>` +
  RIDGE;
/** Mirrors a left-side shape across the face. */
const MIRROR = 'transform="matrix(-1 0 0 1 640 0)"';
const mirrored = (id: string, body: string) => `<g id="${id}">${body}</g><use href="#${id}" ${MIRROR}/>`;

/**
 * A night city: a skyline in the sky's edge colour with lit windows and neon
 * rain in the mote colour, behind a low moss horizon. Parameters set the mood.
 */
const DUSK_A = frag("duskA", '<defs><radialGradient id="b" cx=".5" cy=".45" r=".7"><stop offset="0" stop-color="');
const DUSK_B = frag("duskB", '"/><stop offset="1" stop-color="');
const DUSK_C = frag("duskC", '"/></radialGradient></defs><rect width="640" height="640" fill="url(#b)"/><g color="');
const DUSK_W = frag("duskW", '"><defs><path id="d" d="M0 560V420h34v-36h28v60h20v-96h40v120h16v-54h30v66h22v-50h48v40h40v-28h44v36h36v-58h30v-60h26v78h22v-110h38v124h20v-72h30v58h24v-44h32v50h60v116z"/><pattern id="o" width="26" height="34" patternUnits="userSpaceOnUse"><path d="M6 8h4v6H6zM17 22h3v5h-3z" fill="currentColor" fill-opacity=".32"/></pattern><pattern id="r" width="64" height="150" patternUnits="userSpaceOnUse"><path d="M12 0v34M44 70v22M30 112v30" stroke="currentColor" stroke-opacity=".2" stroke-width="1.5"/></pattern></defs><rect width="640" height="560" fill="url(#r)"/><use href="#d" fill="#000" fill-opacity=".38"/><use href="#d" fill="url(#o)"/><path d="M90 340h24M438 320h26M528 372h18" stroke="#d58aac" stroke-width="10" stroke-opacity=".22"/><path d="M90 340h24M438 320h26M528 372h18" stroke="#ff9cc6" stroke-width="3"/><path d="M0 560c50-56 118-50 160-22 46-44 112-48 160-16 52-36 122-34 168 2 56-30 112-22 152 6v30z" fill="');
const DUSK_E = frag("duskE", '"/><g fill="currentColor" fill-opacity=".5"><circle cx="96" cy="520" r="3"/><circle cx="118" cy="530" r="2"/><circle cx="530" cy="512" r="3"/><circle cx="552" cy="526" r="2"/><circle cx="470" cy="110" r="2"/><circle cx="160" cy="150" r="2"/></g></g>');
const DUSK_E_CLOSE = frag("close", '"/>');
/** Rain, windows and motes take the mote colour once, through currentColor. */
const dusk = (center: string, edge: string, hill: string, mote: string): Seg[] =>
  [DUSK_A, center, DUSK_B, edge, DUSK_C, mote, DUSK_W, hill, DUSK_E];

/** Circuit traces on a dark plate under a vignette. */
const CIRC_A = frag("circA", '<defs><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M0 40h22l12-12h22M40 0v14l10 10M56 80V62l12-12h12M80 20H64" fill="none" stroke="');
const CIRC_B = frag("circB", `" stroke-width="2"/><circle cx="56" cy="28" r="3" fill="${NEON}" fill-opacity=".7"/><circle cx="68" cy="50" r="2" fill="`);
const CIRC_C = frag("circC", '"/></pattern><radialGradient id="b" cx=".5" cy=".45" r=".65"><stop offset="0" stop-color="');
const CIRC_D = frag("circD", '" stop-opacity="0"/><stop offset="1" stop-color="');
const CIRC_E = frag("circE", '"/></radialGradient></defs><rect width="640" height="640" fill="');
const CIRC_F = frag("circF", '"/><rect width="640" height="640" fill="url(#p)"/><rect width="640" height="640" fill="url(#b)"/>');
const circuit = (base: string, trace: string, vignette: string): Seg[] =>
  [CIRC_A, trace, CIRC_B, trace, CIRC_C, base, CIRC_D, vignette, CIRC_E, base, CIRC_F];

/** A vertical gradient under magenta haze, a mint glow and scanlines. */
const SCAN_A = frag("scanA", '<defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="');
const SCAN_C = frag("scanC", '"/></linearGradient><radialGradient id="h"><stop offset="0" stop-color="#d58aac" stop-opacity=".45"/><stop offset="1" stop-color="#d58aac" stop-opacity="0"/></radialGradient><radialGradient id="g"><stop offset="0" stop-color="#3fb98c" stop-opacity=".4"/><stop offset="1" stop-color="#3fb98c" stop-opacity="0"/></radialGradient><pattern id="s" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity=".28"/></pattern></defs><rect width="640" height="640" fill="url(#b)"/><circle cx="500" cy="150" r="260" fill="url(#h)"/><circle cx="130" cy="430" r="240" fill="url(#g)"/><rect width="640" height="640" fill="url(#s)"/>');
const scanline = (top: string, bottom: string): Seg[] => [SCAN_A, top, DUSK_B, bottom, SCAN_C];

/** Fogged glass panes with light streaks and a low planted bed. */
const GLASS_C = frag("glassC", '"/></linearGradient><radialGradient id="h"><stop offset="0" stop-color="#fff" stop-opacity="');
const GLASS_D = frag("glassD", '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="640" height="640" fill="url(#b)"/><circle cx="150" cy="140" r="190" fill="url(#h)"/><circle cx="520" cy="260" r="150" fill="url(#h)"/><path d="M84 0v210M112 0v120M548 0v300M572 0v90M600 0v180" stroke="#fff" stroke-opacity="');
const GLASS_E = frag("glassE", '" stroke-width="3" stroke-linecap="round"/><path d="M0 560c60-40 130-36 180-10 50-34 120-36 170-6 54-30 130-28 180 4 40-16 80-14 110 2v10z" fill="');
const glass = (top: string, bottom: string, light: string, streak: string, bed: string): Seg[] =>
  [SCAN_A, top, DUSK_B, bottom, GLASS_C, light, GLASS_D, streak, GLASS_E, bed, DUSK_E_CLOSE];

/** A neon bloom behind the head with two halo rings. */
const BLOOM_A = frag("bloomA", `<defs><radialGradient id="b" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="${NEON}" stop-opacity=".55"/><stop offset=".55" stop-color="`);
const BLOOM_B = frag("bloomB", '" stop-opacity=".35"/><stop offset="1" stop-color="');
const BLOOM_C = frag("bloomC", `" stop-opacity="0"/></radialGradient></defs><rect width="640" height="640" fill="`);
const BLOOM_D = frag("bloomD", `"/><circle cx="320" cy="330" r="330" fill="url(#b)"/><g fill="none" stroke="${NEON}" stroke-opacity=".35" stroke-width="2"><circle cx="320" cy="330" r="214"/><circle cx="320" cy="330" r="262" stroke-dasharray="4 10"/></g>`);
const bloom = (mid: string, base: string): Seg[] => [BLOOM_A, mid, BLOOM_B, base, BLOOM_C, base, BLOOM_D];

/**
 * Frosted glass stars scattered on sheets of dyed paper under a spotlight: a
 * star is a faceted six-point star over its own shadow, in two sizes.
 */
const STARS_A = frag("starsA", '<defs><pattern id="m" width="160" height="128" patternUnits="userSpaceOnUse" patternTransform="rotate(-3)"><path d="M6 6h98v72H6z" fill="#fff" fill-opacity=".05"/><path d="M.5 0v128M0 .5h160" stroke="#000" stroke-opacity=".35"/><g fill="#2b1d14"><circle cx="122" cy="96" r="2.2"/><circle cx="131" cy="101" r="2"/><circle cx="126" cy="108" r="2.2"/></g></pattern><radialGradient id="b" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient><linearGradient id="W" x2="1" y2="1"><stop offset=".3" stop-color="#fff"/><stop offset="1" stop-color="#bcd9e0"/></linearGradient><path id="a" d="M0-18L3-5 16-9 6 0 16 9 3 5 0 18-3 5-16 9-6 0-16-9-3-5z"/><g id="A"><use href="#a" x="3" y="5" fill="#000" fill-opacity=".35"/><use href="#a" fill="url(#W)" fill-opacity=".92"/><path d="M0-18V18M16-9L-16 9M16 9L-16-9" stroke="#fff" stroke-opacity=".8"/></g><use id="E" href="#A" transform="scale(.55)"/></defs><rect width="640" height="640" fill="');
const STARS_B = frag("starsB", '"/><rect width="640" height="640" fill="url(#m)"/><rect width="640" height="640" fill="url(#b)"/><use href="#A" x="72" y="112"/><use href="#A" x="566" y="92"/><use href="#A" x="98" y="338"/><use href="#A" x="548" y="352"/><use href="#A" x="150" y="492"/><use href="#E" x="186" y="52"/><use href="#E" x="468" y="42"/><use href="#E" x="604" y="214"/><use href="#E" x="38" y="226"/><use href="#E" x="494" y="506"/><use href="#E" x="196" y="176"/>');
const stars = (paper: string): Seg[] => [STARS_A, paper, STARS_B];

/**
 * Backgrounds are deep so pale glass stands out; deep greenhouse glass is a
 * dark, fogged night version. Obsidian glass adds LIFT on top (see below).
 */
const BACKGROUND: Trait = {
  label: "Background",
  weights: [52, 44, 36, 32, 32, 24, 24, 12],
  names: ["Night moss", "Circuit plate", "Scanline haze", "Greenhouse glass", "Glass stars", "Blue paper", "Obsidian", "Neon bloom"],
  art: [
    dusk("#2c4a39", "#0d1712", "#1b3024", "#d9f2e2"),
    circuit("#0f1a15", "#24453a", "#08100c"),
    scanline("#261c2e", "#0f1f19"),
    glass("#2d493d", "#11241c", ".12", ".12", "#091a11"),
    stars("#1d5257"),
    stars("#203a63"),
    dusk("#272c2e", "#060808", "#141819", NEON),
    bloom("#1d6b52", "#07100c"),
  ],
};
/**
 * Dark coats (obsidian) get the same background under a pale haze, lifting it
 * to OKLCH lightness ~0.5 so a near-black bunny never sits on a near-black sky.
 */
export const LIFT = '<rect width="640" height="640" fill="#c9d6cf" fill-opacity=".45"/>';

/**
 * Glass is gradient definitions only: f (body), e (inner ear), c (light pooled
 * in the muzzle and chest). It then opens a group that rims the ears in light
 * and lets the background show through them, closed by BODY.
 */
const FUR_A = frag("furA", '<defs><linearGradient id="f" x2="');
const FUR_B = frag("furB", '" y2="1"><stop offset="0" stop-color="');
const FUR_C = frag("furC", '"/><stop offset=".5" stop-color="');
const FUR_D = frag("furD", '"/><stop offset="1" stop-color="');
const FUR_E = frag("furE", '"/></linearGradient><linearGradient id="e" x2="0" y2="1"><stop offset="0" stop-color="');
const FUR_F = frag("furF", '" stop-opacity=".6"/><stop offset="1" stop-color="');
const FUR_G = frag("furG", '"/></linearGradient><radialGradient id="c"><stop offset="0" stop-color="');
const FUR_H = frag("furH", '"/><stop offset="1" stop-color="');
const FUR_I = frag("furI", '" stop-opacity="0"/></radialGradient></defs><g opacity=".85" stroke="#fff" stroke-opacity=".6" stroke-width="2">');
const furDefs = (top: string, mid: string, bottom: string, ear: string, light: string, across = "0"): Seg[] =>
  [FUR_A, across, FUR_B, top, FUR_C, mid, FUR_D, bottom, FUR_E, ear, FUR_F, ear, FUR_G, light, FUR_H, light, FUR_I];

/** 1 when the glass needs the lifting haze over its background (obsidian only). */
export const FUR_TONE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0];

/**
 * Each glass is lit from above, deepest through the middle and catching bounce
 * light again at the base; clear crystal and opal shade across instead.
 */
const FUR: Trait = {
  label: "Glass",
  weights: [48, 36, 32, 28, 28, 22, 22, 18, 14, 8],
  names: ["Frosted", "Moss glass", "Smoke", "Clear crystal", "Obsidian", "Lilac glass", "Amber", "Sea glass", "Pale gold", "Opal"],
  art: [
    furDefs("#f6fbfb", "#d3e4e4", "#eaf4f3", "#cfe6ee", "#fff"),
    furDefs("#dcebc4", "#a6c486", "#cfe2b4", "#eef6d9", "#f7fbe9"),
    furDefs("#c6cecb", "#8c9894", "#b3bdba", NEON, "#e3e9e7"),
    furDefs("#fff", "#b9d3db", "#eef7fa", "#d6ecf4", "#fff", "1"),
    furDefs("#56625e", "#252d2b", "#404b48", "#c86f9a", "#7d8a86"),
    furDefs("#f1e6f7", "#cbb4dd", "#e4d6ef", "#f6d9e9", "#fbf6fd"),
    furDefs("#f7dcae", "#d79a52", "#eec48c", "#fbe6c4", "#fff3dd"),
    furDefs("#cdeee5", "#7dc0af", "#b4e0d4", "#e2f7f0", "#f2fcf9"),
    furDefs("#fbf3d2", "#e2cc84", "#f2e3ae", "#fbf0d6", "#fffbea"),
    furDefs("#ecfff8", "#a6e8d6", "#ead2f6", "#f6d7ff", "#fff", "1"),
  ],
};

const upright = (x: number, angle: number, cy: number, ry: number) =>
  `<ellipse cx="${x}" cy="${cy}" rx="25" ry="${ry}" transform="rotate(${angle} ${x} ${cy})" fill="url(#f)"/><ellipse cx="${x}" cy="${cy + 8}" rx="11" ry="${ry - 22}" transform="rotate(${angle} ${x} ${cy + 8})" fill="url(#e)"/>`;
/**
 * A lop ear: rooted high on the crown, arching over the side of the head and
 * hanging to the jaw with a spoon-shaped tip. Drawn after the head.
 */
const LOP = frag(
  "lop",
  '<g id="l"><path d="M292 230c-10-28-44-40-70-26-24 12-36 42-46 84-14 56-28 100-28 150 0 34 20 56 44 54 26-2 38-28 34-60-4-36-10-72-8-112 2-30 12-50 34-62 14-8 28-12 40-28z" fill="url(#f)" stroke="#fff" stroke-opacity=".5" stroke-width="2"/><ellipse cx="188" cy="420" rx="21" ry="58" transform="rotate(8 188 420)" fill="url(#e)"/><path d="M226 210c-20 12-32 40-38 76" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/></g>',
);
const UPRIGHT_PAIR = frag("upright", upright(290, -7, 148, 104) + upright(350, 7, 148, 104));

const EARS: Trait = {
  label: "Ears",
  weights: [80, 56, 48, 44, 28],
  names: ["Upright", "One lop", "Lop", "Ink tipped", "Extra tall"],
  art: [
    [UPRIGHT_PAIR],
    upright(350, 7, 148, 104),
    "",
    [
      '<clipPath id="t"><ellipse cx="290" cy="148" rx="25" ry="104" transform="rotate(-7 290 148)"/><ellipse cx="350" cy="148" rx="25" ry="104" transform="rotate(7 350 148)"/></clipPath>',
      UPRIGHT_PAIR,
      `<path clip-path="url(#t)" d="M240 30h160v54H240z" fill="${INK}"/>`,
    ],
    upright(290, -6, 130, 122) + upright(350, 6, 130, 122),
  ],
  front: ["", [LOP], [LOP, `<use href="#l" ${MIRROR}/>`], "", ""],
};

/**
 * Body and head, shared by every bunny; the outfit layer sits between them.
 * Each shape is defined once (Q body, P head) and drawn twice: in its glass,
 * then under rim gradient G, which brightens the edges the way frosted glass
 * does, with a lit outline and specular streaks on top.
 */
const RIM = 'fill="url(#G)" stroke="#fff" stroke-opacity=".6" stroke-width="2"/>';
const BODY =
  '</g><defs><path id="Q" d="M204 560c4-56 34-86 76-96 8-2 14-8 16-16h48c2 8 8 14 16 16 42 10 72 40 76 96z"/>' +
  '<radialGradient id="G"><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></radialGradient></defs>' +
  `<use href="#Q" fill="url(#f)"/><ellipse cx="320" cy="526" rx="40" ry="34" fill="url(#c)" fill-opacity=".5"/><use href="#Q" ${RIM}` +
  '<path d="M232 546q6-52 56-76" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>';
const HEAD =
  '<ellipse cx="320" cy="458" rx="34" ry="8" fill="#000" fill-opacity=".16"/>' +
  '<defs><path id="P" d="M320 226c54 0 90 40 98 94 4 26 14 42 14 66 0 46-50 70-112 70s-112-24-112-70c0-24 10-40 14-66 8-54 44-94 98-94z"/></defs>' +
  `<use href="#P" fill="url(#f)"/><ellipse cx="320" cy="410" rx="36" ry="28" fill="url(#c)" fill-opacity=".8"/><use href="#P" ${RIM}` +
  '<g fill="none" stroke="#fff" stroke-linecap="round"><path d="M244 306q10-50 58-70" stroke-opacity=".55" stroke-width="5"/><path d="M414 410q-16 30-50 40" stroke-opacity=".35" stroke-width="4"/></g><circle cx="316" cy="240" r="3.5" fill="#fff" fill-opacity=".7"/>';

const HOODIE_A = frag("hoodA", '<use href="#Q" fill="');
const HOODIE_B = frag("hoodB", '"/><path d="M262 468q58 30 116 0" fill="none" stroke="');
const HOODIE_C = frag("hoodC", '" stroke-width="16" stroke-linecap="round"/><path d="M306 486v34M334 486v34" stroke="');
const HOODIE_D = frag("hoodD", '" stroke-width="3" stroke-linecap="round"/><path d="M262 546q58-14 116 0" fill="none" stroke="');
const HOODIE_E = frag("hoodE", '" stroke-width="3"/>');
const hoodie = (base: string, dark: string, strings: string): Seg[] =>
  [HOODIE_A, base, HOODIE_B, dark, HOODIE_C, strings, HOODIE_D, dark, HOODIE_E];

const OUTFIT: Trait = {
  label: "Outfit",
  weights: [72, 44, 40, 32, 32, 24, 12],
  names: ["None", "Moss hoodie", "Techwear", "LED harness", "Black hoodie", "Haze hoodie", "Glass armor"],
  art: [
    "",
    hoodie("#2d5a44", "#214733", "#e8efe9"),
    `<use href="#Q" fill="#141c18" stroke="#33443c" stroke-width="3"/><path d="M284 452l36 30 36-30" fill="none" stroke="#26332d" stroke-width="12" stroke-linejoin="round"/><path d="M320 486v74" stroke="${NEON}" stroke-width="3"/><path d="M230 546q22-46 64-60M410 546q-22-46-64-60" fill="none" stroke="${NEON}" stroke-opacity=".6" stroke-width="2"/><rect x="344" y="512" width="20" height="10" rx="2" fill="${NEON}" fill-opacity=".8"/>`,
    `<use href="#Q" fill="#151d1a"/><path d="M270 470l100 90M370 470l-100 90" stroke="#2a3832" stroke-width="16"/><path d="M270 470l100 90M370 470l-100 90" stroke="${NEON}" stroke-width="3" stroke-dasharray="10 6"/><circle cx="320" cy="515" r="13" fill="#0c120f" stroke="${NEON}" stroke-width="3"/>`,
    hoodie("#1b2220", "#0c100e", NEON),
    hoodie("#7d6290", "#5c4570", "#f3e3ff"),
    `<use href="#Q" fill="#e9f7f0" fill-opacity=".55" stroke="${NEON}" stroke-width="2"/><path d="M320 476v84M252 508l68 20 68-20" fill="none" stroke="${NEON}" stroke-opacity=".7" stroke-width="2"/>`,
  ],
};

/** Every marking is mirrored or centred, so both halves of the face match. */
const MARKING: Trait = {
  label: "Marking",
  weights: [88, 56, 40, 28, 24, 20],
  names: ["None", "Temple ports", "Neon freckles", "LED stripe", "Brow LEDs", "Circuit lines"],
  art: [
    "",
    mirrored("k1", `<ellipse cx="236" cy="336" rx="16" ry="20" fill="${NEON}" fill-opacity=".14"/><rect x="228" y="322" width="14" height="28" rx="5" fill="${INK}"/><circle cx="235" cy="330" r="3" fill="${NEON}"/><circle cx="235" cy="342" r="3" fill="${NEON}" fill-opacity=".55"/>`),
    mirrored("k4", `<g fill="${NEON}" fill-opacity=".8"><circle cx="248" cy="386" r="2.6"/><circle cx="260" cy="392" r="2.2"/><circle cx="246" cy="398" r="2"/></g>`),
    `<rect x="310" y="236" width="20" height="74" rx="10" fill="${NEON}" fill-opacity=".18"/><rect x="316" y="242" width="8" height="62" rx="4" fill="${NEON}" fill-opacity=".85"/>`,
    mirrored("k2", `<ellipse cx="276" cy="316" rx="13" ry="8" transform="rotate(-12 276 316)" fill="${NEON}" fill-opacity=".2"/><ellipse cx="276" cy="316" rx="9" ry="4" transform="rotate(-12 276 316)" fill="${NEON}"/>`),
    mirrored("k3", `<path d="M232 372h16l8 8h12M240 390h14" fill="none" stroke="${NEON}" stroke-width="3" stroke-linecap="round"/><circle cx="272" cy="380" r="3.5" fill="${NEON}"/>`),
  ],
};

/** The plain pair, shared with the cyber eye, which covers the right eye with an implant. */
const FOCUSED = frag("focused", mirrored("y", eyeShape()));
const IMPLANT = `<path d="M332 334q28-26 70-12l12 22q2 24-14 38l-30 10q-30 0-40-24z" fill="#1d2a24" stroke="#33443c" stroke-width="3"/><path d="M414 344h20l10 10v44" fill="none" stroke="${NEON}" stroke-width="2.5"/><circle cx="364" cy="352" r="22" fill="#0c120f" stroke="${NEON}" stroke-opacity=".3" stroke-width="10"/><circle cx="364" cy="352" r="20" fill="none" stroke="${NEON}" stroke-width="3"/><circle cx="364" cy="352" r="9" fill="url(#k)"/><circle cx="368" cy="348" r="3" fill="#fff"/><g fill="${NEON}"><circle cx="342" cy="334" r="2.5"/><circle cx="398" cy="378" r="2.5"/></g>`;

const EYES: Trait = {
  label: "Eyes",
  weights: [52, 20, 52, 40, 36, 40, 16],
  names: ["Focused", "Cyber eye", "Cat slit", "Side glance", "Visor", "Shades", "Neon glow"],
  art: [
    [FOCUSED],
    [FOCUSED, IMPLANT],
    mirrored("y", CAT_EYE),
    `<g id="y">${eyeShape(9)}</g><use href="#y" x="88"/>`,
    `<defs><linearGradient id="v" x2="1"><stop offset="0" stop-color="#0d1612"/><stop offset=".5" stop-color="#173a2d"/><stop offset="1" stop-color="#0d1612"/></linearGradient></defs><rect x="226" y="330" width="188" height="42" rx="21" fill="url(#v)" stroke="url(#k)" stroke-opacity=".7" stroke-width="3"/><path d="M246 347h96" stroke="url(#k)" stroke-width="5" stroke-linecap="round"/><path d="M358 347h26" stroke="url(#k)" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>`,
    `<defs><linearGradient id="v" x2="0" y2="1"><stop offset="0" stop-color="#1a2420"/><stop offset="1" stop-color="#050807"/></linearGradient></defs>` +
      mirrored("y", `<path d="M236 336h66c4 0 6 3 5 7l-6 16c-3 9-10 13-19 13h-28c-9 0-16-5-18-14l-4-15c-1-4 1-7 4-7z" fill="url(#v)" stroke="${INK}" stroke-width="3"/><path d="M246 344l16 0-20 20z" fill="url(#k)" fill-opacity=".45"/>`) +
      `<path d="M306 342q14-8 28 0" fill="none" stroke="${INK}" stroke-width="5"/><path d="M226 340l-14-6M414 340l14-6" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`,
    `<defs><radialGradient id="n"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="${NEON}"/><stop offset="1" stop-color="${NEON}" stop-opacity="0"/></radialGradient></defs>` +
      mirrored("y", `<ellipse cx="277" cy="352" rx="40" ry="24" fill="url(#n)" fill-opacity=".45"/>${eyeShape(0, "n")}`),
  ],
};

/** The shared face: a rose glass-bead nose. The mouth under it comes with the signal. */
const FACE =
  '<path d="M309 394q11-8 22 0q-3 10-11 12q-8-2-11-12z" fill="#e48aa6"/><ellipse cx="315" cy="397" rx="3.5" ry="2" fill="#fff" fill-opacity=".85"/>';
/** A clean signal: a small carved smile, its lower edge catching the light. */
const SMILE =
  `<path d="M320 406v8M298 410q10 14 22 4q12 10 22-4" fill="none" stroke="${INK}" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/>` +
  '<path d="M300 414q10 13 20 4q10 9 20-4" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/>';
/** A glitched signal: the wide, toothy crescent grin, curling up toward the cheeks. */
const GRIN =
  `<path d="M320 406v6" stroke="${INK}" stroke-opacity=".7" stroke-width="3" stroke-linecap="round"/>` +
  `<path d="M262 404q58 22 116 0q-6 34-58 38q-52-4-58-38z" fill="${INK}"/>` +
  '<path d="M268 409q52 18 104 0l-4 9q-48 14-96 0z" fill="#f4f1e6"/>' +
  '<path d="M284 428q36 12 72 0l-3 9q-33 9-66 0z" fill="#f4f1e6" fill-opacity=".9"/>' +
  `<path d="M280 412l2 10M292 415l1 10M304 417v10M316 418v10M328 418v10M340 417v10M352 415l-1 10M362 412l-2 10M296 431l1 8M308 433v8M320 434v8M332 433v8M344 431l-1 8" stroke="${INK}" stroke-width="2"/>` +
  `<path d="M262 404q-8-2-12-12M378 404q8-2 12-12" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;

/** Drone: a hover drone off the right ear, its lens in the eye colour, scanning the bunny. */
const HEADWEAR: Trait = {
  label: "Headwear",
  weights: [84, 36, 32, 24, 20, 32, 28],
  names: ["None", "Moss crown", "Headphones", "Data jack", "Drone", "Beanie", "Bandana"],
  art: [
    "",
    '<g transform="translate(51 21) scale(.84)"><g fill="#5f7f34"><circle cx="258" cy="262" r="20"/><circle cx="382" cy="262" r="20"/><circle cx="320" cy="236" r="20"/></g><g fill="#86a548"><circle cx="282" cy="244" r="24"/><circle cx="358" cy="244" r="24"/></g><g fill="#a9c262"><circle cx="304" cy="232" r="18"/><circle cx="338" cy="234" r="16"/><circle cx="270" cy="252" r="12"/><circle cx="372" cy="254" r="12"/></g><g fill="#fff"><circle cx="276" cy="238" r="5"/><circle cx="352" cy="232" r="5"/><circle cx="320" cy="222" r="4"/><circle cx="388" cy="252" r="4"/><circle cx="252" cy="256" r="4"/></g></g>',
    `<path d="M212 362c0-106 48-156 108-156s108 50 108 156" fill="none" stroke="#1d2a24" stroke-width="14"/><g fill="#1d2a24" stroke="${NEON}" stroke-opacity=".8" stroke-width="3"><rect x="190" y="322" width="38" height="72" rx="17"/><rect x="412" y="322" width="38" height="72" rx="17"/></g>`,
    `<path d="M420 318c46 16 52 86 40 150s14 72 24 92" fill="none" stroke="#1d2a24" stroke-width="10" stroke-linecap="round"/><path d="M420 318c46 16 52 86 40 150s14 72 24 92" fill="none" stroke="${NEON}" stroke-width="2.5" stroke-dasharray="3 12"/><rect x="404" y="304" width="24" height="28" rx="6" fill="#1d2a24" stroke="${NEON}" stroke-width="3"/>`,
    `<path d="M456 140L344 240h64z" fill="${NEON}" fill-opacity=".14"/><g fill="#1d2a24" stroke="${NEON}" stroke-width="2.5"><ellipse cx="398" cy="92" rx="30" ry="6"/><ellipse cx="514" cy="92" rx="30" ry="6"/><path d="M398 97v9h116v-9"/><rect x="426" y="98" width="60" height="38" rx="14"/></g><circle cx="456" cy="119" r="9" fill="url(#k)"/>`,
    `<clipPath id="q"><path id="w" d="M220 298c-2-62 42-92 100-92s102 30 100 92z"/></clipPath><use href="#w" fill="#1f2b26"/><path clip-path="url(#q)" d="M220 236q100-30 200 0M220 264q100-30 200 0" fill="none" stroke="#2c3c35" stroke-width="3"/><path d="M212 290q108-24 216 0l-2 26q-106-22-212 0z" fill="#2c3c35"/><path d="M226 300q94-18 188 0" fill="none" stroke="${NEON}" stroke-opacity=".7" stroke-width="2" stroke-dasharray="6 6"/>`,
    `<path d="M220 280q100-34 200 0l-2 28q-98-30-196 0z" fill="#16201c"/><path d="M228 292q92-26 184 0" fill="none" stroke="${NEON}" stroke-width="2" stroke-dasharray="2 7"/><path d="M420 288l26-10-6 22zM420 296l30 10-22 10z" fill="#16201c"/>`,
  ],
};

const NECKWEAR: Trait = {
  label: "Neckwear",
  weights: [100, 52, 60, 44],
  names: ["None", "Circuit pendant", "LED collar", "Scarf"],
  art: [
    "",
    `<path d="M282 462q38 30 76 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/><rect x="306" y="482" width="28" height="22" rx="5" fill="${INK}" stroke="${NEON}" stroke-width="3"/><path d="M313 493h14" stroke="${NEON}" stroke-width="3"/>`,
    `<path d="M266 460q54 38 108 0" fill="none" stroke="#1d2a24" stroke-width="15" stroke-linecap="round"/><path d="M266 460q54 38 108 0" fill="none" stroke="${NEON}" stroke-width="3.5" stroke-dasharray="4 7"/>`,
    '<path d="M244 458q76 34 152 0l4 26q-80 38-160 0z" fill="#c4577f"/><path d="M352 486l16 62h26l-16-68z" fill="#a8466c"/><path d="M256 470q64 26 128 0" fill="none" stroke="#e48eae" stroke-width="3" stroke-dasharray="10 8"/>',
  ],
};

/** Defines the iris (i) and a flat accent (k) used by the visor and shades. */
const IRIS_A = frag("irisA", '<defs><radialGradient id="i" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".45" stop-color="');
const IRIS_B = frag("irisB", `"/><stop offset="1" stop-color="${INK}"/></radialGradient><linearGradient id="k" gradientUnits="userSpaceOnUse"><stop stop-color="`);
const IRIS_C = frag("irisC", '"/></linearGradient></defs>');
const iris = (color: string): Seg[] => [IRIS_A, color, IRIS_B, color, IRIS_C];

const EYE_COLOR: Trait = {
  label: "Eye color",
  weights: [72, 52, 48, 36, 28, 20],
  names: ["Moss green", "Ice blue", "Amber", "Violet", "Rose", "Silver"],
  art: [iris("#3fb98c"), iris("#6fb7e8"), iris("#e0a43c"), iris("#b388e0"), iris("#e07aa0"), iris("#c7d2cc")],
};

/**
 * Signal: a rare glitched card. Drawn after the bunny (wrapped as #u): magenta
 * and mint channel copies offset either side, and three slices shifted right.
 * Only a glitched bunny wears the grin; a clean one smiles. The grin's band
 * (y 390 to 448) is left out of the copies and slices, so it stays intact.
 */
const SIGNAL: Trait = {
  label: "Signal",
  weights: [236, 20],
  names: ["Clean", "Glitch"],
  art: [
    "",
    '<defs><filter id="xm"><feColorMatrix values="1 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter><filter id="xg"><feColorMatrix values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter><clipPath id="xc"><path d="M0 168h640v20H0zM0 318h640v10H0zM0 456h640v22H0z"/></clipPath><clipPath id="xd"><path d="M0 0h640v390H0zM0 448h640v192H0z"/></clipPath></defs><g opacity=".32" style="mix-blend-mode:screen" clip-path="url(#xd)"><use href="#u" x="-7" filter="url(#xm)"/><use href="#u" x="7" filter="url(#xg)"/></g><use href="#u" x="24" clip-path="url(#xc)"/>',
  ],
  mouth: [SMILE, GRIN],
};

/** Ordered as drawn: earlier entries sit behind later ones. */
export const TRAITS = {
  background: BACKGROUND,
  fur: FUR,
  ears: EARS,
  outfit: OUTFIT,
  marking: MARKING,
  eyes: EYES,
  headwear: HEADWEAR,
  neckwear: NECKWEAR,
  eyeColor: EYE_COLOR,
  signal: SIGNAL,
};
export type TraitKey = keyof typeof TRAITS;
const ORDER = Object.keys(TRAITS) as TraitKey[];

/** Byte i of the receipt hash (most significant first) selects trait i (bytes 0 to 9). */
export function traitIndices(receiptHash: string): Record<TraitKey, number> {
  const value = BigInt(receiptHash);
  return Object.fromEntries(
    ORDER.map((key, i) => {
      const byte = Number((value >> BigInt(248 - 8 * i)) & BigInt(255));
      let total = 0;
      const index = TRAITS[key].weights.findIndex((w) => byte < (total += w));
      return [key, index];
    }),
  ) as Record<TraitKey, number>;
}

export function badgeTraits(receiptHash: string): { trait_type: string; value: string }[] {
  const picked = traitIndices(receiptHash);
  return ORDER.map((key) => ({ trait_type: TRAITS[key].label, value: TRAITS[key].names[picked[key]] }));
}

/** `0x1234abcd...ef567890`, matching the contract's shortened receipt. */
export function shortReceipt(receiptHash: string): string {
  const hex = BigInt(receiptHash).toString(16).padStart(64, "0");
  return `0x${hex.slice(0, 8)}...${hex.slice(-8)}`;
}

/** The receipt hash as a 2x128 strip, most significant bit first. */
export function bitPath(receiptHash: string): string {
  const value = BigInt(receiptHash);
  let path = "";
  for (let i = 0; i < 256; i++) {
    if (((value >> BigInt(255 - i)) & BigInt(1)) === BigInt(0)) continue;
    path += `M${64 + (i % 128) * 4} ${572 + Math.floor(i / 128) * 4}h3v3h-3z`;
  }
  return path;
}

export const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">';
/** Groups the drawn bunny so the signal layer can reuse it. */
export const ART_OPEN = '<g id="u">';
export const ART_CLOSE = "</g>";
/** HUD corner brackets and a faint scanline over the art, then the footer. */
export const FOOTER_OPEN =
  '<defs><pattern id="j" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0h4v1H0z" fill="#000" fill-opacity=".14"/></pattern></defs><rect width="640" height="560" fill="url(#j)"/>' +
  `<path d="M24 66V24h42M574 24h42v42M616 494v42h-42M66 536H24v-42" fill="none" stroke="${NEON}" stroke-opacity=".6" stroke-width="3"/>` +
  `<rect y="560" width="640" height="80" fill="#0b130f"/><path d="M0 561h640" stroke="${NEON}" stroke-opacity=".45" stroke-width="2"/>` +
  '<defs><pattern id="z" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#1f3329"/></pattern></defs><rect x="64" y="572" width="512" height="7" fill="url(#z)"/>' +
  `<path fill="${NEON}" d="`;
export const FOOTER_TEXT =
  '"/><g font-family="Helvetica Neue,Helvetica,sans-serif" font-size="19" fill="#cfe0d6"><text x="64" y="618" font-weight="700" letter-spacing="1">MOSS #';
export const RECEIPT_TEXT = '</text><text x="576" y="618" text-anchor="end" fill="#8fa89a">';
export const FOOTER_CLOSE = "</text></g></svg>";

/** Before a receipt exists (the thank-you invite) the bunny is a dark silhouette. */
const UNREVEALED =
  flat(BACKGROUND.art[0]) + LIFT +
  flat(furDefs("#26402f", "#203629", "#192c22", "#2f4c3a", "#2f4c3a")) +
  flat(EARS.art[0]) +
  BODY +
  HEAD +
  `<text x="320" y="396" text-anchor="middle" font-family="Helvetica Neue,Helvetica,sans-serif" font-size="64" font-weight="700" fill="${NEON}" fill-opacity=".8">?</text>`;

export function badgeSvg(index?: number | bigint, receiptHash?: string): string {
  if (!receiptHash)
    return (
      SVG_OPEN + UNREVEALED + FOOTER_OPEN + FOOTER_TEXT + String(index ?? "") +
      RECEIPT_TEXT + "HATCHES FROM YOUR RECEIPT" + FOOTER_CLOSE
    );
  const picked = traitIndices(receiptHash);
  const art = (key: TraitKey) => flat(TRAITS[key].art[picked[key]]);
  const background = flat(BACKGROUND.art[picked.background]) + (FUR_TONE[picked.fur] ? LIFT : "");
  return (
    SVG_OPEN + ART_OPEN +
    background + art("fur") + art("ears") + BODY + art("outfit") + HEAD + flat(EARS.front?.[picked.ears] ?? "") +
    art("marking") + art("eyes") + FACE + flat(SIGNAL.mouth?.[picked.signal] ?? "") + art("neckwear") + art("headwear") + art("eyeColor") +
    ART_CLOSE + art("signal") + FOOTER_OPEN + bitPath(receiptHash) + FOOTER_TEXT + String(index ?? "") +
    RECEIPT_TEXT + shortReceipt(receiptHash) + FOOTER_CLOSE
  );
}

export function badgeDataUri(index?: number | bigint, receiptHash?: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(index, receiptHash))}`;
}

/** Fragments the generated Solidity library embeds verbatim. */
export const SHARED_ART = { BODY, HEAD, FACE };
