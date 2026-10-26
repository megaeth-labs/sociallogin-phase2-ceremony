// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Groth16Verifier} from "../src/Verifier.sol";

interface Vm {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUintArray(string calldata json, string calldata key) external pure returns (uint256[] memory);
    function projectRoot() external view returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
}

/// Exercises the exact exported verifier against one fresh proof: the proof is
/// accepted, and changing any public input, negating a proof point or passing
/// an out-of-field input is rejected.
contract VerifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // BN254 scalar and base field moduli, as in the snarkjs template.
    uint256 constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    address verifier;
    uint256[] pA;
    uint256[] pB;
    uint256[] pC;
    uint256[] pub;

    function setUp() public {
        verifier = address(new Groth16Verifier());
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/fixture/fixture.json"));
        pA = vm.parseJsonUintArray(json, ".pA");
        pB = vm.parseJsonUintArray(json, ".pB");
        pC = vm.parseJsonUintArray(json, ".pC");
        pub = vm.parseJsonUintArray(json, ".pubSignals");
        require(pA.length == 2 && pB.length == 4 && pC.length == 2 && pub.length > 0, "malformed fixture");
    }

    function accepts(uint256[] memory a, uint256[] memory signals) internal view returns (bool) {
        // Static arrays encode inline, so the calldata is the selector followed
        // by every word in order; this works for any public-input count.
        bytes memory data = abi.encodePacked(
            bytes4(keccak256(bytes(string.concat(
                "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[", vm.toString(signals.length), "])"
            )))),
            a[0], a[1], pB[0], pB[1], pB[2], pB[3], pC[0], pC[1]
        );
        for (uint256 i = 0; i < signals.length; i++) data = abi.encodePacked(data, signals[i]);
        (bool ok, bytes memory result) = verifier.staticcall(data);
        return ok && result.length == 32 && abi.decode(result, (bool));
    }

    function testAcceptsTheValidProof() public view {
        require(accepts(pA, pub), "valid proof rejected");
    }

    function testRejectsEachModifiedPublicInput() public view {
        for (uint256 i = 0; i < pub.length; i++) {
            uint256[] memory signals = pub;
            signals[i] = addmod(signals[i], 1, R);
            require(!accepts(pA, signals), string.concat("modified input accepted: ", vm.toString(i)));
        }
    }

    function testRejectsTheNegatedProofPoint() public view {
        uint256[] memory a = pA;
        a[1] = Q - a[1];
        require(!accepts(a, pub), "negated proof point accepted");
    }

    function testRejectsAnOutOfFieldPublicInput() public view {
        uint256[] memory signals = pub;
        signals[0] = signals[0] + R;
        require(!accepts(pA, signals), "out-of-field input accepted");
    }
}
