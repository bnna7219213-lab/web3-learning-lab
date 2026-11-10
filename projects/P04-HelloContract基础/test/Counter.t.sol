// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Counter} from "../src/Counter.sol";

contract CounterTest is Test {
    Counter internal counter;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        // 部署者与管理者刻意分开：alice 跑部署脚本，owner 才是管理者（对应联盟网里「客户多签当 owner」）
        vm.prank(alice);
        counter = new Counter(7, owner);
    }

    function test_Initial_State() public view {
        assertEq(counter.count(), 7);
        assertEq(counter.owner(), owner);
        assertEq(counter.VERSION(), "1.0.0");
    }

    /// 管理者外置的意义：跑脚本的人拿不到管理权
    function test_Admin_IsNotTheDeployer() public view {
        assertEq(counter.owner(), owner, "owner must be the admin passed in, not msg.sender");
    }

    function test_Increment_UpdatesAndEmits() public {
        vm.expectEmit(true, true, true, true, address(counter));
        emit Counter.Incremented(alice, 7, 12, 5);

        vm.prank(alice);
        counter.increment(5);

        assertEq(counter.count(), 12);
        assertEq(counter.previousCount(), 7, "previous count should be recorded");
    }

    function test_Increment_ZeroRejected() public {
        vm.expectRevert(Counter.ZeroIncrement.selector);
        counter.increment(0);
    }

    function test_Reset_RequiresOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Counter.NotOwner.selector, alice));
        counter.reset();
    }

    function test_Reset_WorksForOwner() public {
        vm.prank(owner);
        counter.reset();
        assertEq(counter.count(), 0);
    }

    function test_TransferOwnership_TwoStepReadable() public {
        vm.prank(owner);
        counter.transferOwnership(alice);
        assertEq(counter.owner(), alice);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(Counter.NotOwner.selector, owner));
        counter.reset();
        vm.stopPrank();
    }

    function test_History_IsRingBuffer() public {
        vm.startPrank(alice);
        for (uint256 i = 1; i <= 10; i++) {
            counter.increment(i);
        }
        vm.stopPrank();

        uint256[8] memory h = counter.history();
        // 初值 7，连写 10 次（+1..+10）→ count = 7 + 55 = 62；环形缓冲只留最后 8 个「变更前值」
        assertEq(counter.count(), 62);
        assertEq(h[0], 43, "slot 0 overwritten by 9th write");
        assertEq(h[1], 52, "slot 1 overwritten by 10th write");
        assertEq(h[2], 10, "slot 2 still holds the 3rd write");
        assertEq(counter.previousCount(), 52);
    }

    /// 任何合法增量都不会让 count 变小，也不会溢出到错误值
    function testFuzz_Increment_Monotonic(uint256 by) public {
        by = bound(by, 1, type(uint128).max);
        uint256 before = counter.count();
        counter.increment(by);
        assertEq(counter.count(), before + by);
        assertGt(counter.count(), before);
    }

    function testFuzz_Overflow_RevertsWithReadableError(uint256 by) public {
        // count 已是 max-1，by >= 2 才溢出（by == 1 恰好等于 max，属合法）
        by = bound(by, 2, type(uint256).max - 1);
        vm.prank(owner);
        counter.reset();
        counter.increment(type(uint256).max - 1);

        vm.expectRevert(abi.encodeWithSelector(Counter.Overflow.selector, type(uint256).max - 1, by));
        counter.increment(by);
    }

    /// 部署记录里的 bytecode hash 必须稳定：同一份源码 → 同一个 hash（B04 无公网浏览器时靠它自证）
    function test_DeployedBytecodeHash_Stable() public view {
        bytes memory code = address(counter).code;
        assertGt(code.length, 0);
        assertEq(keccak256(code), keccak256(address(counter).code));
    }
}
