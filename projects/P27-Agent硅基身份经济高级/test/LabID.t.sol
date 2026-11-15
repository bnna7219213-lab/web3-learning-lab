// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {LabID} from "../src/LabID.sol";

/// 身份层：soulbound / 一地址一 ID / 角色门禁 / PII 只存承诺 / tier 阈值推导与降级。
contract LabIDTest is Test {
    LabID internal id;
    address internal admin = makeAddr("admin");
    address internal registrar = makeAddr("registrar");
    address internal signal = makeAddr("signalRegistry");
    address internal alice = makeAddr("alice");
    address internal agent = makeAddr("agent");
    bytes32 internal registrarRole;
    bytes32 internal signalRole;

    function setUp() public {
        id = new LabID(admin);
        registrarRole = id.REGISTRAR_ROLE();
        signalRole = id.SIGNAL_ROLE();
        vm.startPrank(admin);
        id.grantRole(registrarRole, registrar);
        id.grantRole(signalRole, signal);
        vm.stopPrank();
    }

    function test_Mint_RecordsIdentityWithoutPII() public {
        bytes32 commit = keccak256("kyc-material-digest+salt");
        vm.expectEmit(true, true, false, true);
        emit LabID.IdentityMinted(1, alice, false, commit);
        vm.prank(registrar);
        uint256 tokenId = id.mint(alice, false, commit);

        assertEq(tokenId, 1);
        assertEq(id.idOf(alice), 1);
        assertEq(id.ownerOf(1), alice);
        LabID.Identity memory ident = id.identityOf(1);
        assertEq(ident.tier, 0);
        assertEq(ident.reputation, 0);
        assertFalse(ident.isAgent);
        assertEq(ident.kycCommit, commit); // 链上只有哈希承诺，没有 PII 原文
        assertEq(ident.mintedAt, uint64(block.timestamp));
    }

    function test_Mint_AgentFlagIsLabelNotPrivilege() public {
        vm.prank(registrar);
        id.mint(agent, true, keccak256("agent-kyc"));
        assertTrue(id.identityOf(id.idOf(agent)).isAgent);
        assertEq(id.tierOf(agent), 0); // 硅基出生也是 T0，与碳基一致
    }

    function test_Mint_OnlyRegistrar() public {
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        vm.prank(alice);
        id.mint(alice, false, bytes32(0));
    }

    function test_Mint_OneAddressOneId() public {
        vm.startPrank(registrar);
        id.mint(alice, false, keccak256("a"));
        vm.expectRevert(abi.encodeWithSelector(LabID.AlreadyHasIdentity.selector, alice));
        id.mint(alice, false, keccak256("b"));
        vm.stopPrank();
        assertEq(id.nextId(), 2); // 失败的铸造不消耗 ID
    }

    function test_Mint_ZeroSubjectRejected() public {
        vm.expectRevert(LabID.ZeroAddress.selector);
        vm.prank(registrar);
        id.mint(address(0), false, bytes32(0));
    }

    function test_Soulbound_TransferRejected() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.expectRevert(LabID.Soulbound.selector);
        vm.prank(alice);
        id.transferFrom(alice, agent, 1);
        assertEq(id.ownerOf(1), alice);
    }

    function test_Soulbound_SafeTransferRejected() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.expectRevert(LabID.Soulbound.selector);
        vm.prank(alice);
        id.safeTransferFrom(alice, agent, 1);
    }

    function test_Soulbound_ApprovedOperatorStillRejected() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.prank(alice);
        id.approve(agent, 1); // approve 本身不拦截，转让在 _update 单漏斗被拒
        vm.expectRevert(LabID.Soulbound.selector);
        vm.prank(agent);
        id.transferFrom(alice, agent, 1);
    }

    function test_AddReputation_OnlySignalRole() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        vm.prank(alice);
        id.addReputation(alice, 100);
    }

    function test_AddReputation_NoIdentityRejected() public {
        vm.expectRevert(abi.encodeWithSelector(LabID.NoIdentity.selector, alice));
        vm.prank(signal);
        id.addReputation(alice, 100);
    }

    function test_Tier_ThresholdBoundaries() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        uint256[6] memory reps = [uint256(0), 99, 100, 499, 500, 2000];
        uint8[6] memory want = [0, 0, 1, 1, 2, 3];
        uint256 prev;
        for (uint256 i; i < reps.length; ++i) {
            vm.prank(signal);
            id.addReputation(alice, int256(reps[i] - prev));
            assertEq(id.tierOf(alice), want[i], "tier at boundary");
            prev = reps[i];
        }
        assertEq(id.tierOf(alice), 3);
    }

    function test_Tier_DowngradeClampsAtZero() public {
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.startPrank(signal);
        id.addReputation(alice, 2000);
        assertEq(id.tierOf(alice), 3);
        vm.expectEmit(true, false, false, true);
        emit LabID.TierChanged(1, 3, 0);
        id.addReputation(alice, -5000); // 超额扣减钳制到 0，不能为负
        vm.stopPrank();
        assertEq(id.reputationOf(alice), 0);
        assertEq(id.tierOf(alice), 0);
    }

    function test_IdentityOf_UnknownTokenRejected() public {
        vm.expectRevert(abi.encodeWithSelector(LabID.UnknownIdentity.selector, 999));
        id.identityOf(999);
    }

    function test_Constructor_ZeroAdminRejected() public {
        vm.expectRevert(LabID.ZeroAddress.selector);
        new LabID(address(0));
    }

    function test_SupportsERC721Interface() public view {
        assertTrue(id.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(id.supportsInterface(0x7965db0b)); // AccessControl
    }

    function testFuzz_TierAlwaysMatchesThresholds(uint256 rep) public {
        rep = bound(rep, 0, 1_000_000);
        vm.prank(registrar);
        id.mint(alice, false, bytes32(0));
        vm.prank(signal);
        id.addReputation(alice, int256(rep));
        uint8 want = rep >= 2000 ? 3 : rep >= 500 ? 2 : rep >= 100 ? 1 : 0;
        assertEq(id.tierOf(alice), want);
        assertEq(id.reputationOf(alice), rep);
    }
}
