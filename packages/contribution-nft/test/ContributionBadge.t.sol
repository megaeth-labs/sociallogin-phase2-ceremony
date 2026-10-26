// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ContributionBadge} from "../src/ContributionBadge.sol";
import {BadgeRenderer} from "../src/BadgeRenderer.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function warp(uint256) external;
    function chainId(uint256) external;
}
contract ContributionBadgeTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ContributionBadge badge;
    BadgeRenderer art;
    address recipient;
    bytes32 constant RECEIPT = keccak256("accepted-receipt");
    uint256 constant SIGNER = 0x123;
    function setUp() public {
        recipient = vm.addr(0x456);
        art = new BadgeRenderer();
        badge = new ContributionBadge(keccak256("ceremony"), vm.addr(SIGNER), address(this), false, art);
    }
    function testRequiresADeployedRenderer() public {
        vm.expectRevert(ContributionBadge.InvalidRenderer.selector);
        new ContributionBadge(keccak256("ceremony"), vm.addr(SIGNER), address(this), false, BadgeRenderer(address(0)));
        vm.expectRevert(ContributionBadge.InvalidRenderer.selector);
        new ContributionBadge(keccak256("ceremony"), vm.addr(SIGNER), address(this), false, BadgeRenderer(recipient));
        require(address(badge.renderer()) == address(art));
    }
    function signature(ContributionBadge target, address to, bytes32 receipt, uint256 index, uint256 deadline) internal returns (bytes memory) {
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("MOSS Ceremony Contribution"), keccak256("1"), block.chainid, address(target)));
        bytes32 hash = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(target.CLAIM_TYPEHASH(), to, receipt, index, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER, hash);
        return abi.encodePacked(r,s,v);
    }
    function mint() internal {
        bytes memory sig = signature(badge, recipient, RECEIPT, 7, block.timestamp + 60);
        vm.prank(recipient); badge.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
    }
    function testClaimAndOnchainMetadata() public {
        mint(); require(badge.ownerOf(uint256(RECEIPT)) == recipient);
        require(badge.claimedBy(RECEIPT) == recipient);
        require(badge.contributionIndex(uint256(RECEIPT)) == 7);
        bytes memory uri = bytes(badge.tokenURI(uint256(RECEIPT)));
        require(uri.length > 1000 && uri[0] == 'd');
    }
    // Pinned in apps/ceremony/src/lib/nft/badge-svg.test.ts too: if either side's SVG drifts, both fail.
    bytes32 constant BADGE_SVG_FIXTURE_KECCAK = 0xc53535c1c5dea89507dca20dbeb49ff0da19e90a89ab825c2bcd64d064505594;
    function testBadgeArtMatchesWebPreview() public {
        require(keccak256(bytes(badge.renderer().svg(uint256(RECEIPT), 7))) == BADGE_SVG_FIXTURE_KECCAK);
    }
    // An obsidian coat on night moss: exercises the lifting haze.
    bytes32 constant OBSIDIAN_RECEIPT = 0x03905a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a;
    bytes32 constant OBSIDIAN_SVG_FIXTURE_KECCAK = 0x60856272c4805e0b8b4334fc86f550d12e6eec5e56ed7b5a37c63c313bae83cb;
    function testLiftedBackgroundMatchesWebPreview() public view {
        require(keccak256(bytes(badge.renderer().svg(uint256(OBSIDIAN_RECEIPT), 9))) == OBSIDIAN_SVG_FIXTURE_KECCAK);
    }
    // Byte 9 = 0xf0: the rare glitched signal layer over the grouped bunny.
    bytes32 constant GLITCH_RECEIPT = 0x5a5a5a5a5a5a5a5a5af05a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a;
    bytes32 constant GLITCH_SVG_FIXTURE_KECCAK = 0xc793a397dec45f3360f10d293c1672786871a5a3af0c01fe80603ed137fe939a;
    function testGlitchSignalMatchesWebPreview() public view {
        require(keccak256(bytes(badge.renderer().svg(uint256(GLITCH_RECEIPT), 11))) == GLITCH_SVG_FIXTURE_KECCAK);
    }
    function testTraitsComeFromTheReceiptHash() public {
        require(keccak256(bytes(badge.renderer().attributes(uint256(RECEIPT)))) == keccak256(bytes(
            '{"trait_type":"Background","value":"Greenhouse glass"},{"trait_type":"Glass","value":"Pale gold"},{"trait_type":"Ears","value":"Ink tipped"},{"trait_type":"Outfit","value":"Techwear"},{"trait_type":"Marking","value":"Brow LEDs"},{"trait_type":"Eyes","value":"Side glance"},{"trait_type":"Headwear","value":"None"},{"trait_type":"Neckwear","value":"LED collar"},{"trait_type":"Eye color","value":"Moss green"},{"trait_type":"Signal","value":"Clean"}'
        )));
    }
    function testTokenUriGas() public {
        mint();
        uint256 before = gasleft();
        badge.tokenURI(uint256(RECEIPT));
        // Comfortably inside default eth_call gas caps (RPCs commonly allow 50M).
        require(before - gasleft() < 5_000_000);
    }
    function testCannotClaimTwiceOrChangeWallet() public {
        mint(); bytes memory sig = signature(badge, recipient, RECEIPT, 7, block.timestamp + 60);
        vm.prank(recipient); vm.expectRevert(ContributionBadge.AlreadyClaimed.selector);
        badge.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
        address other = vm.addr(0x789); sig = signature(badge, other, RECEIPT, 7, block.timestamp + 60);
        vm.prank(other); vm.expectRevert(ContributionBadge.AlreadyClaimed.selector);
        badge.claim(other, RECEIPT, 7, block.timestamp + 60, sig);
    }
    function testRejectsFrontRunAndTamperedReceipt() public {
        bytes memory sig = signature(badge, recipient, RECEIPT, 7, block.timestamp + 60);
        vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        badge.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
        vm.prank(recipient); vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        badge.claim(recipient, keccak256("different"), 7, block.timestamp + 60, sig);
    }
    function testRejectsExpiredWrongContractAndWrongChain() public {
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = signature(badge, recipient, RECEIPT, 7, deadline);
        ContributionBadge other = new ContributionBadge(keccak256("other"), vm.addr(SIGNER), address(this), false, art);
        vm.prank(recipient); vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        other.claim(recipient, RECEIPT, 7, deadline, sig);
        vm.chainId(block.chainid + 1);
        vm.prank(recipient); vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        badge.claim(recipient, RECEIPT, 7, deadline, sig);
        vm.warp(deadline + 1);
        vm.prank(recipient); vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        badge.claim(recipient, RECEIPT, 7, deadline, sig);
    }
    function testMintingPauseAndSignerRotation() public {
        bytes memory sig = signature(badge, recipient, RECEIPT, 7, block.timestamp + 60);
        badge.setPaused(true); vm.prank(recipient); vm.expectRevert(ContributionBadge.MintingPaused.selector);
        badge.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
        badge.setPaused(false); badge.setClaimSigner(vm.addr(99));
        vm.prank(recipient); vm.expectRevert(ContributionBadge.InvalidClaim.selector);
        badge.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
        vm.prank(recipient); vm.expectRevert(); badge.setPaused(true);
    }
    function testSmartAccountReceiverCannotReplayDuringCallback() public {
        BadgeReceiver receiver = new BadgeReceiver(badge, true);
        bytes memory sig = signature(badge, address(receiver), RECEIPT, 7, block.timestamp + 60);
        receiver.collect(RECEIPT, block.timestamp + 60, sig);
        require(badge.ownerOf(uint256(RECEIPT)) == address(receiver));
        require(!receiver.replayed());
    }
    function testRejectedReceiverDoesNotConsumeClaim() public {
        BadgeReceiver receiver = new BadgeReceiver(badge, false);
        bytes memory sig = signature(badge, address(receiver), RECEIPT, 7, block.timestamp + 60);
        vm.expectRevert(); receiver.collect(RECEIPT, block.timestamp + 60, sig);
        require(badge.claimedBy(RECEIPT) == address(0));
    }

    function testNonTransferableAndExplicitTransferableDeployment() public {
        mint(); vm.prank(recipient); vm.expectRevert(ContributionBadge.NonTransferable.selector);
        badge.transferFrom(recipient, address(0x1234), uint256(RECEIPT));
        ContributionBadge other = new ContributionBadge(keccak256("other"), vm.addr(SIGNER), address(this), true, art);
        bytes memory sig = signature(other, recipient, RECEIPT, 7, block.timestamp + 60);
        vm.prank(recipient); other.claim(recipient, RECEIPT, 7, block.timestamp + 60, sig);
        vm.prank(recipient); other.transferFrom(recipient, address(0x1234), uint256(RECEIPT));
        require(other.ownerOf(uint256(RECEIPT)) == address(0x1234));
        require(other.claimedBy(RECEIPT) == recipient);
    }
}

contract BadgeReceiver {
    ContributionBadge immutable badge;
    bool immutable accepts;
    bytes32 receipt;
    uint256 deadline;
    bytes signature;
    bool public replayed;
    constructor(ContributionBadge target, bool accepts_) { badge = target; accepts = accepts_; }
    function collect(bytes32 receipt_, uint256 deadline_, bytes memory signature_) external {
        receipt = receipt_; deadline = deadline_; signature = signature_;
        badge.claim(address(this), receipt, 7, deadline, signature);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!accepts) return bytes4(0);
        (replayed,) = address(badge).call(abi.encodeCall(badge.claim, (address(this), receipt, 7, deadline, signature)));
        return this.onERC721Received.selector;
    }
}
