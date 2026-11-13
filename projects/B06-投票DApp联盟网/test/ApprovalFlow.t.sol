// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ApprovalFlow} from "../src/ApprovalFlow.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @dev 供 execute 调用的靶子：可切换成 revert 的目标，验证执行失败的重试语义
contract Target {
    uint256 public hits;
    bool public broken;

    function poke() external {
        require(!broken, "target broken");
        hits += 1;
    }

    function setBroken(bool v) external {
        broken = v;
    }
}

contract ApprovalFlowTest is Test {
    ApprovalFlow flow;
    Target target;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice"); // 提案人
    address bob = makeAddr("bob"); // 复核人
    address carol = makeAddr("carol"); // 执行人
    address outsider = makeAddr("outsider");
    uint64 constant DELAY = 1 hours;
    bytes32 proposerRole;
    bytes32 reviewerRole;
    bytes32 executorRole;
    bytes32 adminRole = bytes32(0);

    function setUp() public {
        flow = new ApprovalFlow(admin, DELAY);
        proposerRole = flow.PROPOSER_ROLE();
        reviewerRole = flow.REVIEWER_ROLE();
        executorRole = flow.EXECUTOR_ROLE();
        target = new Target();
        vm.startPrank(admin);
        flow.grantRole(proposerRole, alice);
        flow.grantRole(reviewerRole, bob);
        flow.grantRole(reviewerRole, carol);
        flow.grantRole(executorRole, carol);
        vm.stopPrank();
    }

    function _propose() internal returns (uint256 id) {
        vm.prank(alice);
        id = flow.propose(address(target), 0, abi.encodeCall(Target.poke, ()), unicode"补贴直达-示例");
    }

    // ---------- 全流程（含生效延迟） ----------

    function test_HappyPath_ProposeApproveDelayExecute() public {
        uint256 id = _propose();
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Pending));

        vm.prank(bob);
        flow.approve(id);
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Approved));

        vm.warp(block.timestamp + DELAY);
        vm.prank(carol);
        vm.expectEmit(true, true, false, true);
        emit ApprovalFlow.Executed(id, carol);
        flow.execute(id);
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Executed));
        assertEq(target.hits(), 1);
    }

    function test_RevokeInWindowThenCannotExecute() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);

        // 撤销窗口内（延迟结束前）提案人可撤
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ApprovalFlow.Revoked(id, alice);
        flow.revoke(id);
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Revoked));

        // 撤回后不能再执行
        vm.warp(block.timestamp + DELAY);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.WrongState.selector, id, ApprovalFlow.State.Revoked));
        flow.execute(id);
    }

    function test_RejectWithReason() public {
        uint256 id = _propose();
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit ApprovalFlow.Reviewed(id, bob, false, unicode"材料不全");
        flow.reject(id, unicode"材料不全");
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Rejected));
    }

    // ---------- 双人复核与角色负例 ----------

    /// 双人复核：提案人不能复核自己的提案
    function test_Neg_ProposerCannotReviewOwn() public {
        vm.prank(admin);
        flow.grantRole(reviewerRole, alice); // 即使同时有复核权
        uint256 id = _propose();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.ProposerCannotReview.selector, id, alice));
        flow.approve(id);
    }

    function test_Neg_ProposeWithoutRole() public {
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, proposerRole)
        );
        flow.propose(address(target), 0, "", unicode"越权提案");
    }

    function test_Neg_ApproveWithoutRole() public {
        uint256 id = _propose();
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, reviewerRole)
        );
        flow.approve(id);
    }

    function test_Neg_ExecuteWithoutRole() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, executorRole)
        );
        flow.execute(id);
    }

    /// 生效延迟没到不能执行
    function test_Neg_ExecuteTooEarly() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.TooEarly.selector, id, uint64(block.timestamp) + DELAY));
        flow.execute(id);
    }

    /// 撤销窗口关闭后提案人不能再撤
    function test_Neg_RevokeAfterWindow() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.WindowClosed.selector, id, uint64(block.timestamp)));
        flow.revoke(id);
    }

    /// 复核只能发生一次
    function test_Neg_ReviewTwice() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.WrongState.selector, id, ApprovalFlow.State.Approved));
        flow.reject(id, unicode"再驳一次");
    }

    /// 执行失败整体回滚 ⇒ 提案留在 Approved 可修复后重试
    function test_ExecFailedKeepsApprovedForRetry() public {
        uint256 id = _propose();
        vm.prank(bob);
        flow.approve(id);
        vm.warp(block.timestamp + DELAY);

        target.setBroken(true);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(ApprovalFlow.ExecFailed.selector, id));
        flow.execute(id);
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Approved)); // 退回可重试

        target.setBroken(false);
        vm.prank(carol);
        flow.execute(id);
        assertEq(target.hits(), 1);
        assertEq(uint256(flow.stateOf(id)), uint256(ApprovalFlow.State.Executed));
    }
}
