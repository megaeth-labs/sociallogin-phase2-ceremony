// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BadgeArt} from "./BadgeArt.sol";

/// @notice Draws the bunny's face, accessories and trait metadata. Split from BadgeRenderer
/// so each half stays under the EIP-170 size limit; stateless and pure.
contract BadgeFaceRenderer {
    function face(uint256 receipt) external pure returns (string memory) {
        return BadgeArt.face(receipt);
    }

    function attributes(uint256 receipt) external pure returns (string memory) {
        return BadgeArt.attributes(receipt);
    }
}

/// @notice Holds the bunny artwork so ContributionBadge stays under the EIP-170 size limit.
/// Deployed on its own and passed to the badge's constructor; deploys its face renderer; stateless.
contract BadgeRenderer {
    BadgeFaceRenderer public immutable faces;

    constructor() {
        faces = new BadgeFaceRenderer();
    }

    function svg(uint256 receipt, uint256 index) external view returns (string memory) {
        return BadgeArt.frame(receipt, index, BadgeArt.figure(receipt), faces.face(receipt));
    }

    function attributes(uint256 receipt) external view returns (string memory) {
        return faces.attributes(receipt);
    }
}
