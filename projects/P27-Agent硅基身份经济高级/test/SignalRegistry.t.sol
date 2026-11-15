// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {LabID} from "../src/LabID.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";

/// 信号层：无身份不能提交 / 去重 / 新鲜度 / 3-of-5 阈值 / 防重签 / 权重入账 / 共鸣钩子。
contract SignalRegistryTest is Test {
    LabID internal id;
    SignalRegistry internal reg;
    address internal admin = makeAddr("admin");
    address internal provider = makeAddr("provider");
    address internal alice = makeAddr("alice");

    uint256[5] internal verifierPks;
    address[5] internal verifiers;

    bytes32 internal providerRole;
    bytes32 internal verifierAdminRole;

    function setUp() public {
        vm.warp(1_000_000);
        id = new LabID(admin);
        reg = new SignalRegistry(admin, address(id));
        providerRole = reg.PROVIDER_ROLE();
        verifierAdminRole = reg.VERIFIER_ADMIN_ROLE();

        vm.startPrank(admin);
        id.grantRole(id.SIGNAL_ROLE(), address(reg));
        id.grantRole(id.REGISTRAR_ROLE(), admin);
        id.mint(alice, false, keccak256("kyc"));
        reg.grantRole(providerRole, provider);
        for (uint256 i; i < 5; ++i) {
            verifierPks[i] = 0xA11CE + i;
            verifiers[i] = vm.addr(verifierPks[i]);
            reg.addVerifier(verifiers[i]);
        }
        vm.stopPrank();
    }

    function _commit(bytes32 sigHash, uint8 kind) internal returns (uint256 cid) {
        vm.prank(provider);
        cid = reg.commit(alice, "agent:runtime", sigHash, kind, uint64(block.timestamp));
    }

    function _sig(uint256 cid, uint256 pk) internal view returns (bytes memory) {
        SignalRegistry.Commitment memory c = reg.commitmentOf(cid);
        bytes32 inner =
            keccak256(abi.encodePacked("LabSignal-Confirm", cid, c.subject, c.sigHash, uint8(c.kind), c.ts));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _confirmWith(uint256 cid, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            reg.confirm(cid, _sig(cid, verifierPks[i]));
        }
    }

    // ============ 提交 ============

    function test_Commit_RecordsHashOnly() public {
        bytes32 sigHash = keccak256("signal-vector+salt");
        vm.expectEmit(true, true, false, true);
        emit SignalRegistry.Committed(
            1, alice, sigHash, SignalRegistry.SignalKind.AgentFingerprint, uint64(block.timestamp)
        );
        uint256 cid = _commit(sigHash, 3);
        SignalRegistry.Commitment memory c = reg.commitmentOf(cid);
        assertEq(c.subject, alice);
        assertEq(c.sigHash, sigHash);
        assertEq(c.weight, 20); // AgentFingerprint 权重
        assertFalse(c.confirmed);
        assertEq(c.verifierCount, 0);
    }

    function test_Commit_NoIdentityRejected() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.NoLabID.selector, stranger));
        vm.prank(provider);
        reg.commit(stranger, "d", keccak256("x"), 0, uint64(block.timestamp));
    }

    function test_Commit_OnlyProvider() public {
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        vm.prank(alice);
        reg.commit(alice, "d", keccak256("x"), 0, uint64(block.timestamp));
    }

    function test_Commit_DuplicateKeyRejected() public {
        bytes32 sigHash = keccak256("same");
        _commit(sigHash, 0);
        bytes32 key = keccak256(abi.encodePacked(alice, "agent:runtime", sigHash));
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.DuplicateCommit.selector, key));
        _commit(sigHash, 0);
    }

    function test_Commit_DifferentDomainIsDifferentSignal() public {
        bytes32 sigHash = keccak256("same-vector");
        _commit(sigHash, 0);
        vm.prank(provider);
        uint256 cid2 = reg.commit(alice, "game:lab", sigHash, 0, uint64(block.timestamp));
        assertEq(cid2, 2); // 去重键含 domain：跨域同一向量是两条独立信号
    }

    function test_Commit_StaleSignalRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(SignalRegistry.StaleSignal.selector, uint64(block.timestamp - 25 hours), 24 hours)
        );
        vm.prank(provider);
        reg.commit(alice, "d", keccak256("x"), 0, uint64(block.timestamp - 25 hours));
    }

    function test_Commit_FutureSignalRejected() public {
        uint64 future = uint64(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.FutureSignal.selector, future));
        vm.prank(provider);
        reg.commit(alice, "d", keccak256("x"), 0, future);
    }

    function test_Commit_ZeroHashAndBadKindRejected() public {
        vm.expectRevert(SignalRegistry.ZeroSigHash.selector);
        vm.prank(provider);
        reg.commit(alice, "d", bytes32(0), 0, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.BadSignalKind.selector, 4));
        vm.prank(provider);
        reg.commit(alice, "d", keccak256("x"), 4, uint64(block.timestamp));
    }

    // ============ 阈值确认 ============

    function test_Confirm_TwoOfFiveDoesNotCount() public {
        uint256 cid = _commit(keccak256("s"), 3);
        _confirmWith(cid, 2);
        SignalRegistry.Commitment memory c = reg.commitmentOf(cid);
        assertFalse(c.confirmed);
        assertEq(c.verifierCount, 2);
        assertEq(id.reputationOf(alice), 0); // 未达阈值：声誉一分不入
    }

    function test_Confirm_ThreeOfFiveCreditsReputation() public {
        uint256 cid = _commit(keccak256("s"), 3);
        _confirmWith(cid, 2);
        vm.expectEmit(true, true, false, true);
        emit SignalRegistry.SignalConfirmed(cid, alice, 20, 3);
        reg.confirm(cid, _sig(cid, verifierPks[2]));
        assertTrue(reg.commitmentOf(cid).confirmed);
        assertEq(id.reputationOf(alice), 20);
        assertEq(reg.signersOf(cid).length, 3);
    }

    function test_Confirm_NonVerifierRejected() public {
        uint256 cid = _commit(keccak256("s"), 0);
        uint256 outsiderPk = 0xBAD;
        bytes memory sig = _sig(cid, outsiderPk); // 先算签名：expectRevert 只作用于下一次外部调用
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.NotVerifier.selector, vm.addr(outsiderPk)));
        reg.confirm(cid, sig);
    }

    function test_Confirm_SameVerifierTwiceRejected() public {
        uint256 cid = _commit(keccak256("s"), 0);
        reg.confirm(cid, _sig(cid, verifierPks[0]));
        bytes memory sig = _sig(cid, verifierPks[0]);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.AlreadySigned.selector, cid, verifiers[0]));
        reg.confirm(cid, sig);
    }

    function test_Confirm_AfterConfirmedRejected() public {
        uint256 cid = _commit(keccak256("s"), 0);
        _confirmWith(cid, 3);
        bytes memory sig = _sig(cid, verifierPks[3]);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.AlreadyConfirmed.selector, cid));
        reg.confirm(cid, sig);
    }

    function test_Confirm_UnknownCommitmentRejected() public {
        uint256 cid = _commit(keccak256("s"), 0);
        bytes memory sig = _sig(cid, verifierPks[0]);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.UnknownCommitment.selector, 42));
        reg.confirm(42, sig);
    }

    function test_Confirm_TamperedDigestRecoversWrongSigner() public {
        uint256 cid = _commit(keccak256("s"), 0);
        // 验证者对「篡改过的 sigHash」签名：签名本身合法，但合约按链上承诺重算 digest，
        // recover 出的是随机地址（几乎必然不是在职验证者）→ NotVerifier
        bytes32 inner = keccak256(
            abi.encodePacked(
                "LabSignal-Confirm", cid, alice, keccak256("tampered"), uint8(0), uint64(block.timestamp)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPks[0], digest);
        vm.expectPartialRevert(SignalRegistry.NotVerifier.selector);
        reg.confirm(cid, abi.encodePacked(r, s, v));
    }

    // ============ 权重与 tier 联动 ============

    function test_WeightTableByKind() public {
        uint8[4] memory kinds = [0, 1, 2, 3];
        uint256[4] memory want = [uint256(10), 30, 40, 20];
        for (uint256 i; i < 4; ++i) {
            uint256 cid = _commit(keccak256(abi.encodePacked("w", i)), kinds[i]);
            _confirmWith(cid, 3);
            assertEq(reg.commitmentOf(cid).weight, want[i]);
        }
        assertEq(id.reputationOf(alice), 100); // 10+30+40+20 → 恰好 T1
        assertEq(id.tierOf(alice), 1);
    }

    function test_ResonanceUnlockedOnTierUp() public {
        // 3 条 CrossPlatform(40) = 120 → 跨入 T1，发共鸣钩子
        for (uint256 i; i < 2; ++i) {
            uint256 cid = _commit(keccak256(abi.encodePacked("r", i)), 2);
            _confirmWith(cid, 3);
        }
        uint256 cid3 = _commit(keccak256("r2"), 2);
        _confirmWith(cid3, 2);
        vm.expectEmit(true, true, false, true);
        emit SignalRegistry.ResonanceUnlocked(cid3, alice, 1);
        reg.confirm(cid3, _sig(cid3, verifierPks[2]));
        assertEq(id.tierOf(alice), 1);
    }

    // ============ 验证者治理 ============

    function test_RemovedVerifierCannotSign() public {
        uint256 cid = _commit(keccak256("s"), 0);
        bytes memory sig = _sig(cid, verifierPks[0]);
        vm.prank(admin);
        reg.removeVerifier(verifiers[0]);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.NotVerifier.selector, verifiers[0]));
        reg.confirm(cid, sig);
    }

    function test_AddVerifier_DuplicateAndZeroRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.VerifierAlreadyAdded.selector, verifiers[0]));
        vm.prank(admin);
        reg.addVerifier(verifiers[0]);
        vm.expectRevert(SignalRegistry.ZeroAddress.selector);
        vm.prank(admin);
        reg.addVerifier(address(0));
    }

    function test_SetThreshold_BoundsAndEffect() public {
        vm.expectRevert(SignalRegistry.BadThreshold.selector);
        vm.prank(admin);
        reg.setThreshold(0);
        vm.expectRevert(SignalRegistry.BadThreshold.selector);
        vm.prank(admin);
        reg.setThreshold(6);
        vm.prank(admin);
        reg.setThreshold(2);
        uint256 cid = _commit(keccak256("t"), 0);
        _confirmWith(cid, 2);
        assertTrue(reg.commitmentOf(cid).confirmed); // 阈值降到 2 后 2/5 即入账
    }

    function test_SetKindWeight_GovernanceAndInt256Bound() public {
        vm.prank(admin);
        reg.setKindWeight(3, 50);
        uint256 cid = _commit(keccak256("w"), 3);
        _confirmWith(cid, 3);
        assertEq(id.reputationOf(alice), 50);
        vm.expectRevert(abi.encodeWithSelector(SignalRegistry.WeightTooLarge.selector, uint256(type(int256).max) + 1));
        vm.prank(admin);
        reg.setKindWeight(3, uint256(type(int256).max) + 1);
    }

    function test_Constructor_ZeroAddressRejected() public {
        vm.expectRevert(SignalRegistry.ZeroAddress.selector);
        new SignalRegistry(address(0), address(id));
        vm.expectRevert(SignalRegistry.ZeroAddress.selector);
        new SignalRegistry(admin, address(0));
    }

    function test_VerifierCountView() public view {
        assertEq(reg.verifierCount(), 5);
    }

    function testFuzz_OutsiderSignatureNeverConfirms(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        address signer = vm.addr(pk);
        bool isSetMember;
        for (uint256 i; i < 5; ++i) {
            if (signer == verifiers[i]) isSetMember = true;
        }
        vm.assume(!isSetMember);
        uint256 cid = _commit(keccak256(abi.encodePacked("f", pk)), 0);
        bytes memory sig = _sig(cid, pk);
        vm.expectPartialRevert(SignalRegistry.NotVerifier.selector);
        reg.confirm(cid, sig);
    }
}
