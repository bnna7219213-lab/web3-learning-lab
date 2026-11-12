// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabCredential} from "../src/LabCredential.sol";

/// @notice B07 权益凭证测试：白名单正负例 / 禁二级 / EIP-4907 / 到期回收 / 核销 / 批量与 gas 上限 / Merkle 证明
contract CredentialTest is Test {
    LabCredential cred;
    address admin = address(0xA11CE);
    address memberA = address(0xA11);
    address memberB = address(0xB0B);
    address outsider = address(0xBAD);

    string constant BASE = "http://127.0.0.1:8088/cred/";
    bytes32 constant ROOT = keccak256("root");

    uint256 constant EIP7825_LIMIT = 16_777_216;

    function setUp() public {
        cred = new LabCredential(admin);
        vm.startPrank(admin);
        cred.setMember(memberA, true);
        cred.setMember(memberB, true);
        vm.stopPrank();
    }

    function _mint(address to, uint16 count, uint64 validUntil, bool transferable) internal returns (uint256 startId) {
        vm.prank(admin);
        startId = cred.mintBatch(to, count, BASE, ROOT, validUntil, transferable);
    }

    // ---------------- 发行 ----------------

    function test_MintToMemberWorks() public {
        uint256 startId = _mint(memberA, 3, 0, true);
        assertEq(startId, 0);
        assertEq(cred.nextId(), 3);
        assertEq(cred.ownerOf(0), memberA);
        assertEq(cred.balanceOf(memberA), 3);
        assertEq(cred.tokenURI(1), string.concat(BASE, "1", ".json"));
    }

    function test_MintToNonMemberReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LabCredential.NotMember.selector, outsider));
        _mint(outsider, 1, 0, true);
    }

    function test_MintBatchTooLargeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LabCredential.BatchTooLarge.selector, uint16(251)));
        _mint(memberA, 251, 0, true);
    }

    function test_BatchOfResolvesRanges() public {
        _mint(memberA, 2, 0, true);
        _mint(memberB, 3, 0, true);
        assertEq(cred.batchOf(0), 0);
        assertEq(cred.batchOf(1), 0);
        assertEq(cred.batchOf(2), 1);
        assertEq(cred.batchOf(4), 1);
    }

    // ---------------- 转让策略（禁二级） ----------------

    function test_TransferBetweenMembersWorks() public {
        _mint(memberA, 1, 0, true);
        vm.prank(memberA);
        cred.transferFrom(memberA, memberB, 0);
        assertEq(cred.ownerOf(0), memberB);
    }

    function test_TransferToNonMemberReverts() public {
        _mint(memberA, 1, 0, true);
        vm.prank(memberA);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.NotMember.selector, outsider));
        cred.transferFrom(memberA, outsider, 0);
    }

    function test_TransferFromRemovedMemberReverts() public {
        _mint(memberA, 1, 0, true);
        vm.prank(admin);
        cred.setMember(memberA, false); // 成员资格被撤销 → 不能再转出
        vm.prank(memberA);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.NotMember.selector, memberA));
        cred.transferFrom(memberA, memberB, 0);
    }

    function test_NonTransferableBatchRejectsTransfer() public {
        _mint(memberA, 1, 0, false); // 不可转让批次（如一次性消费券）
        vm.prank(memberA);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.NotTransferable.selector, 0));
        cred.transferFrom(memberA, memberB, 0);
    }

    function test_CheckTransferReturnsReason() public {
        _mint(memberA, 1, 0, true);
        (bool ok, bytes32 reason) = cred.checkTransfer(memberA, outsider, 0);
        assertFalse(ok);
        assertEq(reason, cred.REASON_NOT_MEMBER_TO());
        (ok, reason) = cred.checkTransfer(memberA, memberB, 0);
        assertTrue(ok);
        assertEq(reason, bytes32(0));
    }

    function test_AuditTrailOnBlockedTransfer() public {
        _mint(memberA, 1, 0, true);
        (, bytes32 reason) = cred.checkTransfer(memberA, outsider, 0);
        cred.recordBlockedTransfer(memberA, outsider, 0, reason);
        assertEq(cred.auditCount(), 1);
        (address actor, address from, address to, uint256 tokenId, bytes32 r, uint64 at) = cred.auditEntries(1);
        assertEq(actor, address(this));
        assertEq(from, memberA);
        assertEq(to, outsider);
        assertEq(tokenId, 0);
        assertEq(r, cred.REASON_NOT_MEMBER_TO());
        assertEq(at, uint64(block.timestamp));
    }

    // ---------------- 有效期与自动回收 ----------------

    function test_ExpiredCredentialCannotTransfer() public {
        uint64 until_ = uint64(block.timestamp + 100);
        _mint(memberA, 1, until_, true);
        assertFalse(cred.isExpired(0));
        vm.warp(until_ + 1);
        assertTrue(cred.isExpired(0));
        assertFalse(cred.isValid(0));
        vm.prank(memberA);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.CredentialExpired.selector, 0));
        cred.transferFrom(memberA, memberB, 0);
    }

    /// @notice 「到期自动回收 0 例外」的准确含义：失效判定**不依赖任何人调用**，
    ///         没有任何人调用任何函数时，过期凭证也已经不可转让、不可核销。
    function test_ExpiryIsEffectiveWithoutAnyoneCalling() public {
        uint64 until_ = uint64(block.timestamp + 50);
        _mint(memberA, 1, until_, true);
        vm.warp(until_ + 1);
        assertTrue(cred.isExpired(0));
        vm.prank(memberA);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.CredentialExpired.selector, 0));
        cred.transferFrom(memberA, memberB, 0);
    }

    function test_SweepExpiredBurnsAndRecords() public {
        uint64 until_ = uint64(block.timestamp + 10);
        _mint(memberA, 2, until_, true);
        vm.warp(until_ + 1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        uint256 swept = cred.sweepExpired(ids);
        assertEq(swept, 2);
        assertEq(cred.sweptCount(), 2);
        assertEq(cred.balanceOf(memberA), 0);
    }

    // ---------------- 核销 ----------------

    function test_RedeemBurnsCredential() public {
        _mint(memberA, 1, 0, true);
        vm.prank(admin);
        cred.redeem(0);
        assertEq(cred.balanceOf(memberA), 0);
    }

    function test_RedeemByNonRedeemerReverts() public {
        _mint(memberA, 1, 0, true);
        vm.prank(memberB);
        vm.expectRevert();
        cred.redeem(0);
    }

    function test_RedeemExpiredReverts() public {
        uint64 until_ = uint64(block.timestamp + 10);
        _mint(memberA, 1, until_, true);
        vm.warp(until_ + 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.CredentialExpired.selector, 0));
        cred.redeem(0);
    }

    // ---------------- EIP-4907 ----------------

    function test_SetUserAndExpiry() public {
        _mint(memberA, 1, 0, true);
        vm.prank(memberA);
        cred.setUser(0, memberB, uint64(block.timestamp + 100));
        assertEq(cred.userOf(0), memberB);
        vm.warp(block.timestamp + 101);
        assertEq(cred.userOf(0), address(0)); // 到期即失效，无需任何人收回
    }

    function test_TransferClearsLease() public {
        _mint(memberA, 1, 0, true);
        vm.prank(memberA);
        cred.setUser(0, memberB, uint64(block.timestamp + 1000));
        vm.prank(memberA);
        cred.transferFrom(memberA, memberB, 0);
        assertEq(cred.userOf(0), address(0));
    }

    function test_SetUserByNonHolderReverts() public {
        _mint(memberA, 1, 0, true);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(LabCredential.NotCredentialHolder.selector, 0, outsider));
        cred.setUser(0, outsider, uint64(block.timestamp + 100));
    }

    // ---------------- 角色 ----------------

    function test_MintByNonMinterReverts() public {
        vm.prank(memberA);
        vm.expectRevert();
        cred.mintBatch(memberA, 1, BASE, ROOT, 0, true);
    }

    function test_SetMemberByNonAdminReverts() public {
        vm.prank(memberA);
        vm.expectRevert();
        cred.setMember(outsider, true);
    }

    // ---------------- 批量与 EIP-7825 单笔 gas 上限 ----------------

    /// @notice 1000 份必须分笔：单笔 ERC721 mint 至少两次 SSTORE，约 44k gas/份，
    ///         1000 份 ≈ 44M > 16,777,216 上限。这里实测 250 份一笔的 gas 并断言在上限内。
    function test_Batch250FitsUnderEIP7825Limit() public {
        uint256 gasBefore = gasleft();
        _mint(memberA, 250, 0, true);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("mintBatch(250) gas", used);
        assertLt(used, EIP7825_LIMIT);
        assertEq(cred.balanceOf(memberA), 250);
    }

    function test_FourBatchesCover1000() public {
        for (uint256 i = 0; i < 4; i++) {
            uint256 gasBefore = gasleft();
            _mint(memberA, 250, 0, true);
            uint256 used = gasBefore - gasleft();
            assertLt(used, EIP7825_LIMIT);
        }
        assertEq(cred.nextId(), 1000);
        assertEq(cred.balanceOf(memberA), 1000);
        assertEq(cred.batchCount(), 4);
    }

    // ---------------- Merkle 证明（复刻 shared/evidence 的 v2 结构） ----------------

    /// @dev 与 shared/evidence/lib/merkle-indexed.js 同构：sha256 + 域分隔 + 位置绑定叶子。
    function _commitment(bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("C", uint32(data.length), data));
    }

    function _leafAt(uint256 index, bytes memory data) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("L", uint32(index), _commitment(data)));
    }

    function _nodeHash(uint8 level, uint256 index, bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("N", level, uint32(index), left, right));
    }

    function _emptyLeaf() internal pure returns (bytes32) {
        return sha256(abi.encodePacked("L", "empty"));
    }

    function _buildTree(bytes[] memory items) internal pure returns (bytes32 root) {
        uint256 n = items.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) level[i] = _leafAt(i, items[i]);
        uint8 lvl = 0;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            bytes32[] memory next = new bytes32[](m);
            for (uint256 i = 0; i < n; i += 2) {
                bytes32 left = level[i];
                bytes32 right = i + 1 < n ? level[i + 1] : _emptyLeaf();
                next[i / 2] = _nodeHash(lvl, i / 2, left, right);
            }
            level = next;
            n = m;
            lvl++;
        }
        root = level[0];
    }

    function _proofFor(bytes[] memory items, uint256 index)
        internal
        pure
        returns (LabCredential.ProofStep[] memory proof, bytes32 leafHash)
    {
        uint256 n = items.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) level[i] = _leafAt(i, items[i]);
        bytes32[] memory levels0 = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) levels0[i] = level[i];
        leafHash = level[index];

        uint8 depth = 0;
        uint256 cur = n;
        while (cur > 1) {
            cur = (cur + 1) / 2;
            depth++;
        }
        proof = new LabCredential.ProofStep[](depth);

        uint256 idx = index;
        uint8 lvl = 0;
        uint256 rowLen = n;
        while (rowLen > 1) {
            bool isRight = (idx % 2) == 1;
            uint256 sibIdx = isRight ? idx - 1 : idx + 1;
            bytes32 sibling;
            if (sibIdx < rowLen) {
                sibling = level[sibIdx];
            } else {
                sibling = _emptyLeaf();
            }
            proof[lvl] = LabCredential.ProofStep({sibling: sibling, level: lvl, siblingOnLeft: isRight});
            idx = idx / 2;
            lvl++;
            // 构造上一层
            uint256 m = (rowLen + 1) / 2;
            bytes32[] memory next = new bytes32[](m);
            for (uint256 i = 0; i < rowLen; i += 2) {
                bytes32 left = level[i];
                bytes32 right = i + 1 < rowLen ? level[i + 1] : _emptyLeaf();
                next[i / 2] = _nodeHash(lvl - 1, i / 2, left, right);
            }
            level = next;
            rowLen = m;
        }
    }

    function test_VerifyProofOnChain() public {
        bytes[] memory items = new bytes[](4);
        items[0] = bytes('{"id":0}');
        items[1] = bytes('{"id":1}');
        items[2] = bytes('{"id":2}');
        items[3] = bytes('{"id":3}');
        bytes32 root = _buildTree(items);

        vm.prank(admin);
        cred.mintBatch(memberA, 4, BASE, root, 0, true);

        (LabCredential.ProofStep[] memory proof, bytes32 leaf) = _proofFor(items, 2);
        (bool ok, bytes32 recomputed) = cred.verifyProof(2, leaf, proof);
        assertTrue(ok);
        assertEq(recomputed, root);
        assertEq(cred.merkleRootOf(2), root);
    }

    function test_VerifyProofRejectsTamperedLeaf() public {
        bytes[] memory items = new bytes[](4);
        items[0] = bytes('{"id":0}');
        items[1] = bytes('{"id":1}');
        items[2] = bytes('{"id":2}');
        items[3] = bytes('{"id":3}');
        bytes32 root = _buildTree(items);
        vm.prank(admin);
        cred.mintBatch(memberA, 4, BASE, root, 0, true);

        (LabCredential.ProofStep[] memory proof,) = _proofFor(items, 2);
        (bool ok,) = cred.verifyProof(2, bytes32(uint256(0xdead)), proof);
        assertFalse(ok);
    }
}
