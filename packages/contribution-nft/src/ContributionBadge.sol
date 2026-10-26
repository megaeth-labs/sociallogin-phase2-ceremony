// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {BadgeRenderer} from "./BadgeRenderer.sol";

/// @notice An issuer-authorized souvenir of acceptance, not a cryptographic ceremony proof.
contract ContributionBadge is ERC721, EIP712, Ownable2Step {
    using Strings for uint256;
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address recipient,bytes32 receiptHash,uint256 contributionIndex,uint256 deadline)");
    bytes32 public immutable ceremonyId;
    bool public immutable transferable;
    BadgeRenderer public immutable renderer;
    address public claimSigner;
    bool public paused;
    mapping(bytes32 => address) public claimedBy;
    mapping(uint256 => uint256) public contributionIndex;

    error InvalidClaim();
    error AlreadyClaimed();
    error MintingPaused();
    error NonTransferable();
    error InvalidRenderer();
    event ContributionClaimed(bytes32 indexed receiptHash, address indexed recipient, uint256 contributionIndex);
    event ClaimSignerChanged(address indexed signer);
    event MintingPauseChanged(bool paused);

    /// @param renderer_ A deployed BadgeRenderer. Passed in rather than created here so the art
    /// is not carried in this contract's creation code, which keeps it under the EIP-3860 limit.
    constructor(bytes32 ceremonyId_, address signer_, address owner_, bool transferable_, BadgeRenderer renderer_)
        ERC721("MOSS Ceremony Contribution", "MOSS") EIP712("MOSS Ceremony Contribution", "1") Ownable(owner_)
    {
        if (ceremonyId_ == bytes32(0) || signer_ == address(0)) revert InvalidClaim();
        ceremonyId = ceremonyId_;
        claimSigner = signer_;
        if (address(renderer_).code.length == 0) revert InvalidRenderer();
        transferable = transferable_;
        renderer = renderer_;
    }

    function setClaimSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidClaim();
        claimSigner = signer;
        emit ClaimSignerChanged(signer);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit MintingPauseChanged(value);
    }

    function claim(address recipient, bytes32 receiptHash, uint256 index, uint256 deadline, bytes calldata signature) external {
        if (paused) revert MintingPaused();
        if (recipient != msg.sender || receiptHash == bytes32(0) || index == 0 || block.timestamp > deadline) revert InvalidClaim();
        if (claimedBy[receiptHash] != address(0)) revert AlreadyClaimed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, recipient, receiptHash, index, deadline)));
        if (ECDSA.recover(digest, signature) != claimSigner) revert InvalidClaim();
        // Effects precede the ERC721 receiver callback, including the replay guard.
        claimedBy[receiptHash] = recipient;
        contributionIndex[uint256(receiptHash)] = index;
        _safeMint(recipient, uint256(receiptHash));
        emit ContributionClaimed(receiptHash, recipient, index);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (!transferable && _ownerOf(tokenId) != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    /// @dev Self-contained metadata and artwork: no off-chain image storage dependency.
    /// The bunny is generated from the receipt hash by the renderer; see BadgeArt.sol.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory index = contributionIndex[tokenId].toString();
        string memory svg = renderer.svg(tokenId, contributionIndex[tokenId]);
        string memory json = string.concat(
            '{"name":"MOSS Contributor #', index, '","description":"Commemorates an accepted MOSS ceremony contribution. Not proof of final inclusion, unique identity, or secret erasure.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)), '","attributes":[{"trait_type":"Contribution","value":', index,
            '},{"trait_type":"Ceremony","value":"', Strings.toHexString(uint256(ceremonyId), 32),
            '"},{"trait_type":"Receipt hash","value":"', Strings.toHexString(tokenId, 32), '"},',
            renderer.attributes(tokenId), ']}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
