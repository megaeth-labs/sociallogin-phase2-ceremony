// SPDX-License-Identifier: MIT
// Generated from apps/ceremony/src/lib/nft/badge-svg.ts by badge-art-sol.ts. Do not edit by hand.
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Bunny collectible artwork: traits read from the receipt hash, the full hash drawn as a strip.
library BadgeArt {
    using Strings for uint256;

    /// @dev Background: byte 0 of the receipt hash, weights 52/44/36/32/32/24/24/12 of 256.
    function pickBackground(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 248) & 0xff;
        if (b < 52) return 0;
        if (b < 96) return 1;
        if (b < 132) return 2;
        if (b < 164) return 3;
        if (b < 196) return 4;
        if (b < 220) return 5;
        if (b < 244) return 6;
        return 7;
    }

    function backgroundArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return string.concat(string.concat(_duskA(), '#2c4a39', _duskB(), '#0d1712', _duskC(), '#d9f2e2', _duskW(), '#1b3024'), string.concat(_duskE()));
        if (t == 1) return string.concat(string.concat(_circA(), '#24453a', _circB(), '#24453a', _circC(), '#0f1a15', _circD(), '#08100c'), string.concat(_circE(), '#0f1a15', _circF()));
        if (t == 2) return string.concat(_scanA(), '#261c2e', _duskB(), '#0f1f19', _scanC());
        if (t == 3) return string.concat(string.concat(_scanA(), '#2d493d', _duskB(), '#11241c', _glassC(), '.12', _glassD(), '.12'), string.concat(_glassE(), '#091a11', _close()));
        if (t == 4) return string.concat(_starsA(), '#1d5257', _starsB());
        if (t == 5) return string.concat(_starsA(), '#203a63', _starsB());
        if (t == 6) return string.concat(string.concat(_duskA(), '#272c2e', _duskB(), '#060808', _duskC(), '#5ff0b1', _duskW(), '#141819'), string.concat(_duskE()));
        return string.concat(_bloomA(), '#1d6b52', _bloomB(), '#07100c', _bloomC(), '#07100c', _bloomD());
    }

    function backgroundName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Night moss';
        if (t == 1) return 'Circuit plate';
        if (t == 2) return 'Scanline haze';
        if (t == 3) return 'Greenhouse glass';
        if (t == 4) return 'Glass stars';
        if (t == 5) return 'Blue paper';
        if (t == 6) return 'Obsidian';
        return 'Neon bloom';
    }

    /// @dev Glass: byte 1 of the receipt hash, weights 48/36/32/28/28/22/22/18/14/8 of 256.
    function pickFur(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 240) & 0xff;
        if (b < 48) return 0;
        if (b < 84) return 1;
        if (b < 116) return 2;
        if (b < 144) return 3;
        if (b < 172) return 4;
        if (b < 194) return 5;
        if (b < 216) return 6;
        if (b < 234) return 7;
        if (b < 248) return 8;
        return 9;
    }

    function furArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return string.concat(string.concat(_furA(), '0', _furB(), '#f6fbfb', _furC(), '#d3e4e4', _furD(), '#eaf4f3'), string.concat(_furE(), '#cfe6ee', _furF(), '#cfe6ee', _furG(), '#fff', _furH(), '#fff'), string.concat(_furI()));
        if (t == 1) return string.concat(string.concat(_furA(), '0', _furB(), '#dcebc4', _furC(), '#a6c486', _furD(), '#cfe2b4'), string.concat(_furE(), '#eef6d9', _furF(), '#eef6d9', _furG(), '#f7fbe9', _furH(), '#f7fbe9'), string.concat(_furI()));
        if (t == 2) return string.concat(string.concat(_furA(), '0', _furB(), '#c6cecb', _furC(), '#8c9894', _furD(), '#b3bdba'), string.concat(_furE(), '#5ff0b1', _furF(), '#5ff0b1', _furG(), '#e3e9e7', _furH(), '#e3e9e7'), string.concat(_furI()));
        if (t == 3) return string.concat(string.concat(_furA(), '1', _furB(), '#fff', _furC(), '#b9d3db', _furD(), '#eef7fa'), string.concat(_furE(), '#d6ecf4', _furF(), '#d6ecf4', _furG(), '#fff', _furH(), '#fff'), string.concat(_furI()));
        if (t == 4) return string.concat(string.concat(_furA(), '0', _furB(), '#56625e', _furC(), '#252d2b', _furD(), '#404b48'), string.concat(_furE(), '#c86f9a', _furF(), '#c86f9a', _furG(), '#7d8a86', _furH(), '#7d8a86'), string.concat(_furI()));
        if (t == 5) return string.concat(string.concat(_furA(), '0', _furB(), '#f1e6f7', _furC(), '#cbb4dd', _furD(), '#e4d6ef'), string.concat(_furE(), '#f6d9e9', _furF(), '#f6d9e9', _furG(), '#fbf6fd', _furH(), '#fbf6fd'), string.concat(_furI()));
        if (t == 6) return string.concat(string.concat(_furA(), '0', _furB(), '#f7dcae', _furC(), '#d79a52', _furD(), '#eec48c'), string.concat(_furE(), '#fbe6c4', _furF(), '#fbe6c4', _furG(), '#fff3dd', _furH(), '#fff3dd'), string.concat(_furI()));
        if (t == 7) return string.concat(string.concat(_furA(), '0', _furB(), '#cdeee5', _furC(), '#7dc0af', _furD(), '#b4e0d4'), string.concat(_furE(), '#e2f7f0', _furF(), '#e2f7f0', _furG(), '#f2fcf9', _furH(), '#f2fcf9'), string.concat(_furI()));
        if (t == 8) return string.concat(string.concat(_furA(), '0', _furB(), '#fbf3d2', _furC(), '#e2cc84', _furD(), '#f2e3ae'), string.concat(_furE(), '#fbf0d6', _furF(), '#fbf0d6', _furG(), '#fffbea', _furH(), '#fffbea'), string.concat(_furI()));
        return string.concat(string.concat(_furA(), '1', _furB(), '#ecfff8', _furC(), '#a6e8d6', _furD(), '#ead2f6'), string.concat(_furE(), '#f6d7ff', _furF(), '#f6d7ff', _furG(), '#fff', _furH(), '#fff'), string.concat(_furI()));
    }

    function furName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Frosted';
        if (t == 1) return 'Moss glass';
        if (t == 2) return 'Smoke';
        if (t == 3) return 'Clear crystal';
        if (t == 4) return 'Obsidian';
        if (t == 5) return 'Lilac glass';
        if (t == 6) return 'Amber';
        if (t == 7) return 'Sea glass';
        if (t == 8) return 'Pale gold';
        return 'Opal';
    }

    /// @dev Ears: byte 2 of the receipt hash, weights 80/56/48/44/28 of 256.
    function pickEars(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 232) & 0xff;
        if (b < 80) return 0;
        if (b < 136) return 1;
        if (b < 184) return 2;
        if (b < 228) return 3;
        return 4;
    }

    function earsArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return _upright();
        if (t == 1) return '<ellipse cx="350" cy="148" rx="25" ry="104" transform="rotate(7 350 148)" fill="url(#f)"/><ellipse cx="350" cy="156" rx="11" ry="82" transform="rotate(7 350 156)" fill="url(#e)"/>';
        if (t == 2) return '';
        if (t == 3) return string.concat('<clipPath id="t"><ellipse cx="290" cy="148" rx="25" ry="104" transform="rotate(-7 290 148)"/><ellipse cx="350" cy="148" rx="25" ry="104" transform="rotate(7 350 148)"/></clipPath>', _upright(), '<path clip-path="url(#t)" d="M240 30h160v54H240z" fill="#13201a"/>');
        return '<ellipse cx="290" cy="130" rx="25" ry="122" transform="rotate(-6 290 130)" fill="url(#f)"/><ellipse cx="290" cy="138" rx="11" ry="100" transform="rotate(-6 290 138)" fill="url(#e)"/><ellipse cx="350" cy="130" rx="25" ry="122" transform="rotate(6 350 130)" fill="url(#f)"/><ellipse cx="350" cy="138" rx="11" ry="100" transform="rotate(6 350 138)" fill="url(#e)"/>';
    }

    function earsName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Upright';
        if (t == 1) return 'One lop';
        if (t == 2) return 'Lop';
        if (t == 3) return 'Ink tipped';
        return 'Extra tall';
    }

    function earsFront(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        if (t == 1) return _lop();
        if (t == 2) return string.concat(_lop(), '<use href="#l" transform="matrix(-1 0 0 1 640 0)"/>');
        if (t == 3) return '';
        return '';
    }

    /// @dev Outfit: byte 3 of the receipt hash, weights 72/44/40/32/32/24/12 of 256.
    function pickOutfit(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 224) & 0xff;
        if (b < 72) return 0;
        if (b < 116) return 1;
        if (b < 156) return 2;
        if (b < 188) return 3;
        if (b < 220) return 4;
        if (b < 244) return 5;
        return 6;
    }

    function outfitArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        if (t == 1) return string.concat(string.concat(_hoodA(), '#2d5a44', _hoodB(), '#214733', _hoodC(), '#e8efe9', _hoodD(), '#214733'), string.concat(_hoodE()));
        if (t == 2) return '<use href="#Q" fill="#141c18" stroke="#33443c" stroke-width="3"/><path d="M284 452l36 30 36-30" fill="none" stroke="#26332d" stroke-width="12" stroke-linejoin="round"/><path d="M320 486v74" stroke="#5ff0b1" stroke-width="3"/><path d="M230 546q22-46 64-60M410 546q-22-46-64-60" fill="none" stroke="#5ff0b1" stroke-opacity=".6" stroke-width="2"/><rect x="344" y="512" width="20" height="10" rx="2" fill="#5ff0b1" fill-opacity=".8"/>';
        if (t == 3) return '<use href="#Q" fill="#151d1a"/><path d="M270 470l100 90M370 470l-100 90" stroke="#2a3832" stroke-width="16"/><path d="M270 470l100 90M370 470l-100 90" stroke="#5ff0b1" stroke-width="3" stroke-dasharray="10 6"/><circle cx="320" cy="515" r="13" fill="#0c120f" stroke="#5ff0b1" stroke-width="3"/>';
        if (t == 4) return string.concat(string.concat(_hoodA(), '#1b2220', _hoodB(), '#0c100e', _hoodC(), '#5ff0b1', _hoodD(), '#0c100e'), string.concat(_hoodE()));
        if (t == 5) return string.concat(string.concat(_hoodA(), '#7d6290', _hoodB(), '#5c4570', _hoodC(), '#f3e3ff', _hoodD(), '#5c4570'), string.concat(_hoodE()));
        return '<use href="#Q" fill="#e9f7f0" fill-opacity=".55" stroke="#5ff0b1" stroke-width="2"/><path d="M320 476v84M252 508l68 20 68-20" fill="none" stroke="#5ff0b1" stroke-opacity=".7" stroke-width="2"/>';
    }

    function outfitName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'None';
        if (t == 1) return 'Moss hoodie';
        if (t == 2) return 'Techwear';
        if (t == 3) return 'LED harness';
        if (t == 4) return 'Black hoodie';
        if (t == 5) return 'Haze hoodie';
        return 'Glass armor';
    }

    /// @dev Marking: byte 4 of the receipt hash, weights 88/56/40/28/24/20 of 256.
    function pickMarking(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 216) & 0xff;
        if (b < 88) return 0;
        if (b < 144) return 1;
        if (b < 184) return 2;
        if (b < 212) return 3;
        if (b < 236) return 4;
        return 5;
    }

    function markingArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        if (t == 1) return '<g id="k1"><ellipse cx="236" cy="336" rx="16" ry="20" fill="#5ff0b1" fill-opacity=".14"/><rect x="228" y="322" width="14" height="28" rx="5" fill="#13201a"/><circle cx="235" cy="330" r="3" fill="#5ff0b1"/><circle cx="235" cy="342" r="3" fill="#5ff0b1" fill-opacity=".55"/></g><use href="#k1" transform="matrix(-1 0 0 1 640 0)"/>';
        if (t == 2) return '<g id="k4"><g fill="#5ff0b1" fill-opacity=".8"><circle cx="248" cy="386" r="2.6"/><circle cx="260" cy="392" r="2.2"/><circle cx="246" cy="398" r="2"/></g></g><use href="#k4" transform="matrix(-1 0 0 1 640 0)"/>';
        if (t == 3) return '<rect x="310" y="236" width="20" height="74" rx="10" fill="#5ff0b1" fill-opacity=".18"/><rect x="316" y="242" width="8" height="62" rx="4" fill="#5ff0b1" fill-opacity=".85"/>';
        if (t == 4) return '<g id="k2"><ellipse cx="276" cy="316" rx="13" ry="8" transform="rotate(-12 276 316)" fill="#5ff0b1" fill-opacity=".2"/><ellipse cx="276" cy="316" rx="9" ry="4" transform="rotate(-12 276 316)" fill="#5ff0b1"/></g><use href="#k2" transform="matrix(-1 0 0 1 640 0)"/>';
        return '<g id="k3"><path d="M232 372h16l8 8h12M240 390h14" fill="none" stroke="#5ff0b1" stroke-width="3" stroke-linecap="round"/><circle cx="272" cy="380" r="3.5" fill="#5ff0b1"/></g><use href="#k3" transform="matrix(-1 0 0 1 640 0)"/>';
    }

    function markingName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'None';
        if (t == 1) return 'Temple ports';
        if (t == 2) return 'Neon freckles';
        if (t == 3) return 'LED stripe';
        if (t == 4) return 'Brow LEDs';
        return 'Circuit lines';
    }

    /// @dev Eyes: byte 5 of the receipt hash, weights 52/20/52/40/36/40/16 of 256.
    function pickEyes(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 208) & 0xff;
        if (b < 52) return 0;
        if (b < 72) return 1;
        if (b < 124) return 2;
        if (b < 164) return 3;
        if (b < 200) return 4;
        if (b < 240) return 5;
        return 6;
    }

    function eyesArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return _focused();
        if (t == 1) return string.concat(_focused(), '<path d="M332 334q28-26 70-12l12 22q2 24-14 38l-30 10q-30 0-40-24z" fill="#1d2a24" stroke="#33443c" stroke-width="3"/><path d="M414 344h20l10 10v44" fill="none" stroke="#5ff0b1" stroke-width="2.5"/><circle cx="364" cy="352" r="22" fill="#0c120f" stroke="#5ff0b1" stroke-opacity=".3" stroke-width="10"/><circle cx="364" cy="352" r="20" fill="none" stroke="#5ff0b1" stroke-width="3"/><circle cx="364" cy="352" r="9" fill="url(#k)"/><circle cx="368" cy="348" r="3" fill="#fff"/><g fill="#5ff0b1"><circle cx="342" cy="334" r="2.5"/><circle cx="398" cy="378" r="2.5"/></g>');
        if (t == 2) return '<g id="y"><ellipse cx="277" cy="352" rx="38" ry="22" fill="url(#k)" fill-opacity=".11"/><path d="M246 352q31-28 62 0q-31 24-62 0z" fill="url(#i)" stroke="url(#k)" stroke-width="2"/><path d="M277 337q6 15 0 30q-6-15 0-30z" fill="#13201a"/><circle cx="285" cy="345" r="2.6" fill="#fff"/><path d="M246 347q32-20 62 6" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.5" stroke-linecap="round"/></g><use href="#y" transform="matrix(-1 0 0 1 640 0)"/>';
        if (t == 3) return '<g id="y"><path d="M248 352q28-24 58 0q-29 20-58 0z" fill="#13201a"/><circle cx="287" cy="352" r="11" fill="url(#i)"/><circle cx="287" cy="352" r="4.5" fill="#13201a"/><circle cx="292" cy="347" r="3" fill="#fff"/><circle cx="281" cy="358" r="1.5" fill="#fff" fill-opacity=".6"/><path d="M244 348q30-30 66 6q-34-22-66-6z" fill="url(#f)"/><path d="M246 347q32-20 62 6" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.5" stroke-linecap="round"/></g><use href="#y" x="88"/>';
        if (t == 4) return '<defs><linearGradient id="v" x2="1"><stop offset="0" stop-color="#0d1612"/><stop offset=".5" stop-color="#173a2d"/><stop offset="1" stop-color="#0d1612"/></linearGradient></defs><rect x="226" y="330" width="188" height="42" rx="21" fill="url(#v)" stroke="url(#k)" stroke-opacity=".7" stroke-width="3"/><path d="M246 347h96" stroke="url(#k)" stroke-width="5" stroke-linecap="round"/><path d="M358 347h26" stroke="url(#k)" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>';
        if (t == 5) return '<defs><linearGradient id="v" x2="0" y2="1"><stop offset="0" stop-color="#1a2420"/><stop offset="1" stop-color="#050807"/></linearGradient></defs><g id="y"><path d="M236 336h66c4 0 6 3 5 7l-6 16c-3 9-10 13-19 13h-28c-9 0-16-5-18-14l-4-15c-1-4 1-7 4-7z" fill="url(#v)" stroke="#13201a" stroke-width="3"/><path d="M246 344l16 0-20 20z" fill="url(#k)" fill-opacity=".45"/></g><use href="#y" transform="matrix(-1 0 0 1 640 0)"/><path d="M306 342q14-8 28 0" fill="none" stroke="#13201a" stroke-width="5"/><path d="M226 340l-14-6M414 340l14-6" stroke="#13201a" stroke-width="5" stroke-linecap="round"/>';
        return '<defs><radialGradient id="n"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#5ff0b1"/><stop offset="1" stop-color="#5ff0b1" stop-opacity="0"/></radialGradient></defs><g id="y"><ellipse cx="277" cy="352" rx="40" ry="24" fill="url(#n)" fill-opacity=".45"/><path d="M248 352q28-24 58 0q-29 20-58 0z" fill="#13201a"/><circle cx="278" cy="352" r="11" fill="url(#n)"/><circle cx="278" cy="352" r="4.5" fill="#13201a"/><circle cx="283" cy="347" r="3" fill="#fff"/><circle cx="272" cy="358" r="1.5" fill="#fff" fill-opacity=".6"/><path d="M244 348q30-30 66 6q-34-22-66-6z" fill="url(#f)"/><path d="M246 347q32-20 62 6" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.5" stroke-linecap="round"/></g><use href="#y" transform="matrix(-1 0 0 1 640 0)"/>';
    }

    function eyesName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Focused';
        if (t == 1) return 'Cyber eye';
        if (t == 2) return 'Cat slit';
        if (t == 3) return 'Side glance';
        if (t == 4) return 'Visor';
        if (t == 5) return 'Shades';
        return 'Neon glow';
    }

    /// @dev Headwear: byte 6 of the receipt hash, weights 84/36/32/24/20/32/28 of 256.
    function pickHeadwear(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 200) & 0xff;
        if (b < 84) return 0;
        if (b < 120) return 1;
        if (b < 152) return 2;
        if (b < 176) return 3;
        if (b < 196) return 4;
        if (b < 228) return 5;
        return 6;
    }

    function headwearArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        if (t == 1) return '<g transform="translate(51 21) scale(.84)"><g fill="#5f7f34"><circle cx="258" cy="262" r="20"/><circle cx="382" cy="262" r="20"/><circle cx="320" cy="236" r="20"/></g><g fill="#86a548"><circle cx="282" cy="244" r="24"/><circle cx="358" cy="244" r="24"/></g><g fill="#a9c262"><circle cx="304" cy="232" r="18"/><circle cx="338" cy="234" r="16"/><circle cx="270" cy="252" r="12"/><circle cx="372" cy="254" r="12"/></g><g fill="#fff"><circle cx="276" cy="238" r="5"/><circle cx="352" cy="232" r="5"/><circle cx="320" cy="222" r="4"/><circle cx="388" cy="252" r="4"/><circle cx="252" cy="256" r="4"/></g></g>';
        if (t == 2) return '<path d="M212 362c0-106 48-156 108-156s108 50 108 156" fill="none" stroke="#1d2a24" stroke-width="14"/><g fill="#1d2a24" stroke="#5ff0b1" stroke-opacity=".8" stroke-width="3"><rect x="190" y="322" width="38" height="72" rx="17"/><rect x="412" y="322" width="38" height="72" rx="17"/></g>';
        if (t == 3) return '<path d="M420 318c46 16 52 86 40 150s14 72 24 92" fill="none" stroke="#1d2a24" stroke-width="10" stroke-linecap="round"/><path d="M420 318c46 16 52 86 40 150s14 72 24 92" fill="none" stroke="#5ff0b1" stroke-width="2.5" stroke-dasharray="3 12"/><rect x="404" y="304" width="24" height="28" rx="6" fill="#1d2a24" stroke="#5ff0b1" stroke-width="3"/>';
        if (t == 4) return '<path d="M456 140L344 240h64z" fill="#5ff0b1" fill-opacity=".14"/><g fill="#1d2a24" stroke="#5ff0b1" stroke-width="2.5"><ellipse cx="398" cy="92" rx="30" ry="6"/><ellipse cx="514" cy="92" rx="30" ry="6"/><path d="M398 97v9h116v-9"/><rect x="426" y="98" width="60" height="38" rx="14"/></g><circle cx="456" cy="119" r="9" fill="url(#k)"/>';
        if (t == 5) return '<clipPath id="q"><path id="w" d="M220 298c-2-62 42-92 100-92s102 30 100 92z"/></clipPath><use href="#w" fill="#1f2b26"/><path clip-path="url(#q)" d="M220 236q100-30 200 0M220 264q100-30 200 0" fill="none" stroke="#2c3c35" stroke-width="3"/><path d="M212 290q108-24 216 0l-2 26q-106-22-212 0z" fill="#2c3c35"/><path d="M226 300q94-18 188 0" fill="none" stroke="#5ff0b1" stroke-opacity=".7" stroke-width="2" stroke-dasharray="6 6"/>';
        return '<path d="M220 280q100-34 200 0l-2 28q-98-30-196 0z" fill="#16201c"/><path d="M228 292q92-26 184 0" fill="none" stroke="#5ff0b1" stroke-width="2" stroke-dasharray="2 7"/><path d="M420 288l26-10-6 22zM420 296l30 10-22 10z" fill="#16201c"/>';
    }

    function headwearName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'None';
        if (t == 1) return 'Moss crown';
        if (t == 2) return 'Headphones';
        if (t == 3) return 'Data jack';
        if (t == 4) return 'Drone';
        if (t == 5) return 'Beanie';
        return 'Bandana';
    }

    /// @dev Neckwear: byte 7 of the receipt hash, weights 100/52/60/44 of 256.
    function pickNeckwear(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 192) & 0xff;
        if (b < 100) return 0;
        if (b < 152) return 1;
        if (b < 212) return 2;
        return 3;
    }

    function neckwearArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        if (t == 1) return '<path d="M282 462q38 30 76 0" fill="none" stroke="#13201a" stroke-width="6" stroke-linecap="round"/><rect x="306" y="482" width="28" height="22" rx="5" fill="#13201a" stroke="#5ff0b1" stroke-width="3"/><path d="M313 493h14" stroke="#5ff0b1" stroke-width="3"/>';
        if (t == 2) return '<path d="M266 460q54 38 108 0" fill="none" stroke="#1d2a24" stroke-width="15" stroke-linecap="round"/><path d="M266 460q54 38 108 0" fill="none" stroke="#5ff0b1" stroke-width="3.5" stroke-dasharray="4 7"/>';
        return '<path d="M244 458q76 34 152 0l4 26q-80 38-160 0z" fill="#c4577f"/><path d="M352 486l16 62h26l-16-68z" fill="#a8466c"/><path d="M256 470q64 26 128 0" fill="none" stroke="#e48eae" stroke-width="3" stroke-dasharray="10 8"/>';
    }

    function neckwearName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'None';
        if (t == 1) return 'Circuit pendant';
        if (t == 2) return 'LED collar';
        return 'Scarf';
    }

    /// @dev Eye color: byte 8 of the receipt hash, weights 72/52/48/36/28/20 of 256.
    function pickEyeColor(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 184) & 0xff;
        if (b < 72) return 0;
        if (b < 124) return 1;
        if (b < 172) return 2;
        if (b < 208) return 3;
        if (b < 236) return 4;
        return 5;
    }

    function eyeColorArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return string.concat(_irisA(), '#3fb98c', _irisB(), '#3fb98c', _irisC());
        if (t == 1) return string.concat(_irisA(), '#6fb7e8', _irisB(), '#6fb7e8', _irisC());
        if (t == 2) return string.concat(_irisA(), '#e0a43c', _irisB(), '#e0a43c', _irisC());
        if (t == 3) return string.concat(_irisA(), '#b388e0', _irisB(), '#b388e0', _irisC());
        if (t == 4) return string.concat(_irisA(), '#e07aa0', _irisB(), '#e07aa0', _irisC());
        return string.concat(_irisA(), '#c7d2cc', _irisB(), '#c7d2cc', _irisC());
    }

    function eyeColorName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Moss green';
        if (t == 1) return 'Ice blue';
        if (t == 2) return 'Amber';
        if (t == 3) return 'Violet';
        if (t == 4) return 'Rose';
        return 'Silver';
    }

    /// @dev Signal: byte 9 of the receipt hash, weights 236/20 of 256.
    function pickSignal(uint256 receipt) internal pure returns (uint256) {
        uint256 b = (receipt >> 176) & 0xff;
        if (b < 236) return 0;
        return 1;
    }

    function signalArt(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '';
        return '<defs><filter id="xm"><feColorMatrix values="1 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter><filter id="xg"><feColorMatrix values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter><clipPath id="xc"><path d="M0 168h640v20H0zM0 318h640v10H0zM0 456h640v22H0z"/></clipPath><clipPath id="xd"><path d="M0 0h640v390H0zM0 448h640v192H0z"/></clipPath></defs><g opacity=".32" style="mix-blend-mode:screen" clip-path="url(#xd)"><use href="#u" x="-7" filter="url(#xm)"/><use href="#u" x="7" filter="url(#xg)"/></g><use href="#u" x="24" clip-path="url(#xc)"/>';
    }

    function signalName(uint256 t) internal pure returns (string memory) {
        if (t == 0) return 'Clean';
        return 'Glitch';
    }

    function signalMouth(uint256 t) internal pure returns (string memory) {
        if (t == 0) return '<path d="M320 406v8M298 410q10 14 22 4q12 10 22-4" fill="none" stroke="#13201a" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/><path d="M300 414q10 13 20 4q10 9 20-4" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/>';
        return '<path d="M320 406v6" stroke="#13201a" stroke-opacity=".7" stroke-width="3" stroke-linecap="round"/><path d="M262 404q58 22 116 0q-6 34-58 38q-52-4-58-38z" fill="#13201a"/><path d="M268 409q52 18 104 0l-4 9q-48 14-96 0z" fill="#f4f1e6"/><path d="M284 428q36 12 72 0l-3 9q-33 9-66 0z" fill="#f4f1e6" fill-opacity=".9"/><path d="M280 412l2 10M292 415l1 10M304 417v10M316 418v10M328 418v10M340 417v10M352 415l-1 10M362 412l-2 10M296 431l1 8M308 433v8M320 434v8M332 433v8M344 431l-1 8" stroke="#13201a" stroke-width="2"/><path d="M262 404q-8-2-12-12M378 404q8-2 12-12" fill="none" stroke="#13201a" stroke-width="4" stroke-linecap="round"/>';
    }

    /// @dev 1 when the glass needs the lifting haze over its background (dark glass), else 0.
    function furTone(uint256 fur) internal pure returns (uint256) {
        if (fur == 4) return 1;
        return 0;
    }

    /// @dev The background behind the bunny, hazed for dark glass so it separates from it.
    function backdrop(uint256 receipt) internal pure returns (string memory) {
        string memory art = backgroundArt(pickBackground(receipt));
        return furTone(pickFur(receipt)) == 1 ? string.concat(art, '<rect width="640" height="640" fill="#c9d6cf" fill-opacity=".45"/>') : art;
    }

    function _duskA() private pure returns (string memory) {
        return '<defs><radialGradient id="b" cx=".5" cy=".45" r=".7"><stop offset="0" stop-color="';
    }

    function _duskB() private pure returns (string memory) {
        return '"/><stop offset="1" stop-color="';
    }

    function _duskC() private pure returns (string memory) {
        return '"/></radialGradient></defs><rect width="640" height="640" fill="url(#b)"/><g color="';
    }

    function _duskW() private pure returns (string memory) {
        return '"><defs><path id="d" d="M0 560V420h34v-36h28v60h20v-96h40v120h16v-54h30v66h22v-50h48v40h40v-28h44v36h36v-58h30v-60h26v78h22v-110h38v124h20v-72h30v58h24v-44h32v50h60v116z"/><pattern id="o" width="26" height="34" patternUnits="userSpaceOnUse"><path d="M6 8h4v6H6zM17 22h3v5h-3z" fill="currentColor" fill-opacity=".32"/></pattern><pattern id="r" width="64" height="150" patternUnits="userSpaceOnUse"><path d="M12 0v34M44 70v22M30 112v30" stroke="currentColor" stroke-opacity=".2" stroke-width="1.5"/></pattern></defs><rect width="640" height="560" fill="url(#r)"/><use href="#d" fill="#000" fill-opacity=".38"/><use href="#d" fill="url(#o)"/><path d="M90 340h24M438 320h26M528 372h18" stroke="#d58aac" stroke-width="10" stroke-opacity=".22"/><path d="M90 340h24M438 320h26M528 372h18" stroke="#ff9cc6" stroke-width="3"/><path d="M0 560c50-56 118-50 160-22 46-44 112-48 160-16 52-36 122-34 168 2 56-30 112-22 152 6v30z" fill="';
    }

    function _duskE() private pure returns (string memory) {
        return '"/><g fill="currentColor" fill-opacity=".5"><circle cx="96" cy="520" r="3"/><circle cx="118" cy="530" r="2"/><circle cx="530" cy="512" r="3"/><circle cx="552" cy="526" r="2"/><circle cx="470" cy="110" r="2"/><circle cx="160" cy="150" r="2"/></g></g>';
    }

    function _circA() private pure returns (string memory) {
        return '<defs><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M0 40h22l12-12h22M40 0v14l10 10M56 80V62l12-12h12M80 20H64" fill="none" stroke="';
    }

    function _circB() private pure returns (string memory) {
        return '" stroke-width="2"/><circle cx="56" cy="28" r="3" fill="#5ff0b1" fill-opacity=".7"/><circle cx="68" cy="50" r="2" fill="';
    }

    function _circC() private pure returns (string memory) {
        return '"/></pattern><radialGradient id="b" cx=".5" cy=".45" r=".65"><stop offset="0" stop-color="';
    }

    function _circD() private pure returns (string memory) {
        return '" stop-opacity="0"/><stop offset="1" stop-color="';
    }

    function _circE() private pure returns (string memory) {
        return '"/></radialGradient></defs><rect width="640" height="640" fill="';
    }

    function _circF() private pure returns (string memory) {
        return '"/><rect width="640" height="640" fill="url(#p)"/><rect width="640" height="640" fill="url(#b)"/>';
    }

    function _scanA() private pure returns (string memory) {
        return '<defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="';
    }

    function _scanC() private pure returns (string memory) {
        return '"/></linearGradient><radialGradient id="h"><stop offset="0" stop-color="#d58aac" stop-opacity=".45"/><stop offset="1" stop-color="#d58aac" stop-opacity="0"/></radialGradient><radialGradient id="g"><stop offset="0" stop-color="#3fb98c" stop-opacity=".4"/><stop offset="1" stop-color="#3fb98c" stop-opacity="0"/></radialGradient><pattern id="s" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity=".28"/></pattern></defs><rect width="640" height="640" fill="url(#b)"/><circle cx="500" cy="150" r="260" fill="url(#h)"/><circle cx="130" cy="430" r="240" fill="url(#g)"/><rect width="640" height="640" fill="url(#s)"/>';
    }

    function _glassC() private pure returns (string memory) {
        return '"/></linearGradient><radialGradient id="h"><stop offset="0" stop-color="#fff" stop-opacity="';
    }

    function _glassD() private pure returns (string memory) {
        return '"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="640" height="640" fill="url(#b)"/><circle cx="150" cy="140" r="190" fill="url(#h)"/><circle cx="520" cy="260" r="150" fill="url(#h)"/><path d="M84 0v210M112 0v120M548 0v300M572 0v90M600 0v180" stroke="#fff" stroke-opacity="';
    }

    function _glassE() private pure returns (string memory) {
        return '" stroke-width="3" stroke-linecap="round"/><path d="M0 560c60-40 130-36 180-10 50-34 120-36 170-6 54-30 130-28 180 4 40-16 80-14 110 2v10z" fill="';
    }

    function _close() private pure returns (string memory) {
        return '"/>';
    }

    function _starsA() private pure returns (string memory) {
        return '<defs><pattern id="m" width="160" height="128" patternUnits="userSpaceOnUse" patternTransform="rotate(-3)"><path d="M6 6h98v72H6z" fill="#fff" fill-opacity=".05"/><path d="M.5 0v128M0 .5h160" stroke="#000" stroke-opacity=".35"/><g fill="#2b1d14"><circle cx="122" cy="96" r="2.2"/><circle cx="131" cy="101" r="2"/><circle cx="126" cy="108" r="2.2"/></g></pattern><radialGradient id="b" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient><linearGradient id="W" x2="1" y2="1"><stop offset=".3" stop-color="#fff"/><stop offset="1" stop-color="#bcd9e0"/></linearGradient><path id="a" d="M0-18L3-5 16-9 6 0 16 9 3 5 0 18-3 5-16 9-6 0-16-9-3-5z"/><g id="A"><use href="#a" x="3" y="5" fill="#000" fill-opacity=".35"/><use href="#a" fill="url(#W)" fill-opacity=".92"/><path d="M0-18V18M16-9L-16 9M16 9L-16-9" stroke="#fff" stroke-opacity=".8"/></g><use id="E" href="#A" transform="scale(.55)"/></defs><rect width="640" height="640" fill="';
    }

    function _starsB() private pure returns (string memory) {
        return '"/><rect width="640" height="640" fill="url(#m)"/><rect width="640" height="640" fill="url(#b)"/><use href="#A" x="72" y="112"/><use href="#A" x="566" y="92"/><use href="#A" x="98" y="338"/><use href="#A" x="548" y="352"/><use href="#A" x="150" y="492"/><use href="#E" x="186" y="52"/><use href="#E" x="468" y="42"/><use href="#E" x="604" y="214"/><use href="#E" x="38" y="226"/><use href="#E" x="494" y="506"/><use href="#E" x="196" y="176"/>';
    }

    function _bloomA() private pure returns (string memory) {
        return '<defs><radialGradient id="b" cx=".5" cy=".5" r=".55"><stop offset="0" stop-color="#5ff0b1" stop-opacity=".55"/><stop offset=".55" stop-color="';
    }

    function _bloomB() private pure returns (string memory) {
        return '" stop-opacity=".35"/><stop offset="1" stop-color="';
    }

    function _bloomC() private pure returns (string memory) {
        return '" stop-opacity="0"/></radialGradient></defs><rect width="640" height="640" fill="';
    }

    function _bloomD() private pure returns (string memory) {
        return '"/><circle cx="320" cy="330" r="330" fill="url(#b)"/><g fill="none" stroke="#5ff0b1" stroke-opacity=".35" stroke-width="2"><circle cx="320" cy="330" r="214"/><circle cx="320" cy="330" r="262" stroke-dasharray="4 10"/></g>';
    }

    function _furA() private pure returns (string memory) {
        return '<defs><linearGradient id="f" x2="';
    }

    function _furB() private pure returns (string memory) {
        return '" y2="1"><stop offset="0" stop-color="';
    }

    function _furC() private pure returns (string memory) {
        return '"/><stop offset=".5" stop-color="';
    }

    function _furD() private pure returns (string memory) {
        return '"/><stop offset="1" stop-color="';
    }

    function _furE() private pure returns (string memory) {
        return '"/></linearGradient><linearGradient id="e" x2="0" y2="1"><stop offset="0" stop-color="';
    }

    function _furF() private pure returns (string memory) {
        return '" stop-opacity=".6"/><stop offset="1" stop-color="';
    }

    function _furG() private pure returns (string memory) {
        return '"/></linearGradient><radialGradient id="c"><stop offset="0" stop-color="';
    }

    function _furH() private pure returns (string memory) {
        return '"/><stop offset="1" stop-color="';
    }

    function _furI() private pure returns (string memory) {
        return '" stop-opacity="0"/></radialGradient></defs><g opacity=".85" stroke="#fff" stroke-opacity=".6" stroke-width="2">';
    }

    function _upright() private pure returns (string memory) {
        return '<ellipse cx="290" cy="148" rx="25" ry="104" transform="rotate(-7 290 148)" fill="url(#f)"/><ellipse cx="290" cy="156" rx="11" ry="82" transform="rotate(-7 290 156)" fill="url(#e)"/><ellipse cx="350" cy="148" rx="25" ry="104" transform="rotate(7 350 148)" fill="url(#f)"/><ellipse cx="350" cy="156" rx="11" ry="82" transform="rotate(7 350 156)" fill="url(#e)"/>';
    }

    function _lop() private pure returns (string memory) {
        return '<g id="l"><path d="M292 230c-10-28-44-40-70-26-24 12-36 42-46 84-14 56-28 100-28 150 0 34 20 56 44 54 26-2 38-28 34-60-4-36-10-72-8-112 2-30 12-50 34-62 14-8 28-12 40-28z" fill="url(#f)" stroke="#fff" stroke-opacity=".5" stroke-width="2"/><ellipse cx="188" cy="420" rx="21" ry="58" transform="rotate(8 188 420)" fill="url(#e)"/><path d="M226 210c-20 12-32 40-38 76" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="5" stroke-linecap="round"/></g>';
    }

    function _hoodA() private pure returns (string memory) {
        return '<use href="#Q" fill="';
    }

    function _hoodB() private pure returns (string memory) {
        return '"/><path d="M262 468q58 30 116 0" fill="none" stroke="';
    }

    function _hoodC() private pure returns (string memory) {
        return '" stroke-width="16" stroke-linecap="round"/><path d="M306 486v34M334 486v34" stroke="';
    }

    function _hoodD() private pure returns (string memory) {
        return '" stroke-width="3" stroke-linecap="round"/><path d="M262 546q58-14 116 0" fill="none" stroke="';
    }

    function _hoodE() private pure returns (string memory) {
        return '" stroke-width="3"/>';
    }

    function _focused() private pure returns (string memory) {
        return '<g id="y"><path d="M248 352q28-24 58 0q-29 20-58 0z" fill="#13201a"/><circle cx="278" cy="352" r="11" fill="url(#i)"/><circle cx="278" cy="352" r="4.5" fill="#13201a"/><circle cx="283" cy="347" r="3" fill="#fff"/><circle cx="272" cy="358" r="1.5" fill="#fff" fill-opacity=".6"/><path d="M244 348q30-30 66 6q-34-22-66-6z" fill="url(#f)"/><path d="M246 347q32-20 62 6" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.5" stroke-linecap="round"/></g><use href="#y" transform="matrix(-1 0 0 1 640 0)"/>';
    }

    function _irisA() private pure returns (string memory) {
        return '<defs><radialGradient id="i" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".45" stop-color="';
    }

    function _irisB() private pure returns (string memory) {
        return '"/><stop offset="1" stop-color="#13201a"/></radialGradient><linearGradient id="k" gradientUnits="userSpaceOnUse"><stop stop-color="';
    }

    function _irisC() private pure returns (string memory) {
        return '"/></linearGradient></defs>';
    }

    /// @dev Background, glass, ears, body, outfit and head: drawn by BadgeRenderer.
    function figure(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            backdrop(receipt),
            furArt(pickFur(receipt)),
            earsArt(pickEars(receipt)),
            '</g><defs><path id="Q" d="M204 560c4-56 34-86 76-96 8-2 14-8 16-16h48c2 8 8 14 16 16 42 10 72 40 76 96z"/><radialGradient id="G"><stop offset=".7" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></radialGradient></defs><use href="#Q" fill="url(#f)"/><ellipse cx="320" cy="526" rx="40" ry="34" fill="url(#c)" fill-opacity=".5"/><use href="#Q" fill="url(#G)" stroke="#fff" stroke-opacity=".6" stroke-width="2"/><path d="M232 546q6-52 56-76" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="5" stroke-linecap="round"/>',
            outfitArt(pickOutfit(receipt)),
            '<ellipse cx="320" cy="458" rx="34" ry="8" fill="#000" fill-opacity=".16"/><defs><path id="P" d="M320 226c54 0 90 40 98 94 4 26 14 42 14 66 0 46-50 70-112 70s-112-24-112-70c0-24 10-40 14-66 8-54 44-94 98-94z"/></defs><use href="#P" fill="url(#f)"/><ellipse cx="320" cy="410" rx="36" ry="28" fill="url(#c)" fill-opacity=".8"/><use href="#P" fill="url(#G)" stroke="#fff" stroke-opacity=".6" stroke-width="2"/><g fill="none" stroke="#fff" stroke-linecap="round"><path d="M244 306q10-50 58-70" stroke-opacity=".55" stroke-width="5"/><path d="M414 410q-16 30-50 40" stroke-opacity=".35" stroke-width="4"/></g><circle cx="316" cy="240" r="3.5" fill="#fff" fill-opacity=".7"/>',
            earsFront(pickEars(receipt))
        );
    }

    /// @dev Markings, eyes, nose, the signal's mouth and accessories: drawn by BadgeFaceRenderer.
    function face(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            markingArt(pickMarking(receipt)),
            eyesArt(pickEyes(receipt)),
            '<path d="M309 394q11-8 22 0q-3 10-11 12q-8-2-11-12z" fill="#e48aa6"/><ellipse cx="315" cy="397" rx="3.5" ry="2" fill="#fff" fill-opacity=".85"/>',
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
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><g id="u">',
            figure_,
            face_,
            '</g>',
            signalArt(pickSignal(receipt)),
            '<defs><pattern id="j" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0h4v1H0z" fill="#000" fill-opacity=".14"/></pattern></defs><rect width="640" height="560" fill="url(#j)"/><path d="M24 66V24h42M574 24h42v42M616 494v42h-42M66 536H24v-42" fill="none" stroke="#5ff0b1" stroke-opacity=".6" stroke-width="3"/><rect y="560" width="640" height="80" fill="#0b130f"/><path d="M0 561h640" stroke="#5ff0b1" stroke-opacity=".45" stroke-width="2"/><defs><pattern id="z" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#1f3329"/></pattern></defs><rect x="64" y="572" width="512" height="7" fill="url(#z)"/><path fill="#5ff0b1" d="',
            bitPath(receipt),
            '"/><g font-family="Helvetica Neue,Helvetica,sans-serif" font-size="19" fill="#cfe0d6"><text x="64" y="618" font-weight="700" letter-spacing="1">MOSS #',
            index.toString(),
            '</text><text x="576" y="618" text-anchor="end" fill="#8fa89a">',
            shortReceipt(receipt),
            '</text></g></svg>'
        );
    }

    /// @dev OpenSea attribute objects, comma separated, for the metadata attributes array.
    function attributes(uint256 receipt) internal pure returns (string memory) {
        return string.concat(
            '{"trait_type":"Background","value":"', backgroundName(pickBackground(receipt)), '"}',
            ',',
            '{"trait_type":"Glass","value":"', furName(pickFur(receipt)), '"}',
            ',',
            '{"trait_type":"Ears","value":"', earsName(pickEars(receipt)), '"}',
            ',',
            '{"trait_type":"Outfit","value":"', outfitName(pickOutfit(receipt)), '"}',
            ',',
            '{"trait_type":"Marking","value":"', markingName(pickMarking(receipt)), '"}',
            ',',
            '{"trait_type":"Eyes","value":"', eyesName(pickEyes(receipt)), '"}',
            ',',
            '{"trait_type":"Headwear","value":"', headwearName(pickHeadwear(receipt)), '"}',
            ',',
            '{"trait_type":"Neckwear","value":"', neckwearName(pickNeckwear(receipt)), '"}',
            ',',
            '{"trait_type":"Eye color","value":"', eyeColorName(pickEyeColor(receipt)), '"}',
            ',',
            '{"trait_type":"Signal","value":"', signalName(pickSignal(receipt)), '"}'
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
