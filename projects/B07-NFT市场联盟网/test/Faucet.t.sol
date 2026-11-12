// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabFaucet} from "../src/LabFaucet.sol";

/// @notice LabFaucet 测试：链上强制每日额度 / 单次金额 / 每地址冷却 / UTC 日切 / 治理参数
/// @dev 这一层是「预算治理」的地基：额度一旦写进合约，服务端改本地文件就再也绕不过去。
contract FaucetTest is Test {
    LabFaucet faucet;
    address admin = address(0xFA05);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 constant CAP = 500 ether;
    uint256 constant AMOUNT = 10 ether;
    uint32 constant COOLDOWN = 60;

    function setUp() public {
        faucet = new LabFaucet(admin, CAP, AMOUNT, COOLDOWN);
        vm.deal(address(faucet), 1000 ether);
    }

    // ---------------- 正常领取 ----------------

    function test_ClaimPaysAndRecords() public {
        uint256 before = alice.balance;
        vm.expectEmit(true, true, true, true);
        emit LabFaucet.Payout(alice, AMOUNT, faucet.currentDay(), AMOUNT);
        faucet.claim(alice);

        assertEq(alice.balance, before + AMOUNT);
        assertEq(faucet.spentByDay(faucet.currentDay()), AMOUNT);
        assertEq(faucet.lastClaimAt(alice), block.timestamp);
        assertEq(faucet.claimsByAddress(alice), 1);
        assertEq(faucet.receivedByAddress(alice), AMOUNT);
        assertEq(faucet.totalPaid(), AMOUNT);
        assertEq(faucet.totalClaims(), 1);
    }

    function test_ClaimToContractAddressWorks() public {
        // 用 call 而非 transfer：给合约地址发币也要能成功
        address target = address(0xC0DE);
        faucet.claim(target);
        assertEq(target.balance, AMOUNT);
    }

    // ---------------- 每日额度（链上强制） ----------------

    function test_DailyCapBoundaryAllowsExactCap() public {
        // cap=500、每次 10 → 恰好 50 笔用满，第 51 笔 revert
        for (uint256 i = 0; i < 50; i++) {
            vm.warp(block.timestamp + COOLDOWN);
            faucet.claim(bob);
        }
        assertEq(faucet.spentByDay(faucet.currentDay()), CAP);

        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.DailyCapExceeded.selector, CAP, CAP, AMOUNT));
        faucet.claim(bob);
    }

    function test_CapExhaustedReverts() public {
        // 单独起一个 cap = 单次金额 的实例：第一笔即用满，第二笔必须被链上拒绝
        LabFaucet small = new LabFaucet(admin, AMOUNT, AMOUNT, COOLDOWN);
        vm.deal(address(small), 100 ether);
        small.claim(alice);
        assertEq(small.spentByDay(small.currentDay()), AMOUNT);
        vm.warp(block.timestamp + COOLDOWN);
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.DailyCapExceeded.selector, AMOUNT, AMOUNT, AMOUNT));
        small.claim(bob);
    }

    function test_DailyInfoReportsRemaining() public {
        (, uint256 spent, uint256 remaining, uint256 cap,, uint256 bal) = faucet.dailyInfo();
        assertEq(spent, 0);
        assertEq(remaining, CAP);
        assertEq(cap, CAP);
        assertEq(bal, 1000 ether);

        faucet.claim(alice);
        (, spent, remaining,,, bal) = faucet.dailyInfo();
        assertEq(spent, AMOUNT);
        assertEq(remaining, CAP - AMOUNT);
        assertEq(bal, 1000 ether - AMOUNT);
    }

    function test_CapZeroPausesClaims() public {
        vm.prank(admin);
        faucet.setPolicy(0, AMOUNT, COOLDOWN);
        (bool canClaim,, uint256 remaining, uint256 reason) = faucet.claimable(alice);
        assertFalse(canClaim);
        assertEq(remaining, 0);
        assertEq(reason, 2); // 政策暂停
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.DailyCapExceeded.selector, 0, 0, AMOUNT));
        faucet.claim(alice);
    }

    // ---------------- 每地址冷却（链上强制，重启不清零） ----------------

    function test_CooldownReverts() public {
        faucet.claim(alice);
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.CooldownActive.selector, COOLDOWN));
        faucet.claim(alice);

        vm.warp(block.timestamp + COOLDOWN);
        faucet.claim(alice); // 冷却满即可
        assertEq(faucet.claimsByAddress(alice), 2);
    }

    function test_CooldownIsPerAddress() public {
        faucet.claim(alice);
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.CooldownActive.selector, COOLDOWN));
        faucet.claim(alice);
        faucet.claim(bob); // 别的地址不受影响
        assertEq(faucet.claimsByAddress(bob), 1);
    }

    function test_ClaimableReportsReasonCodes() public {
        (bool canClaim, uint256 wait, uint256 remaining, uint256 reason) = faucet.claimable(alice);
        assertTrue(canClaim);
        assertEq(wait, 0);
        assertEq(remaining, CAP);
        assertEq(reason, 0);

        faucet.claim(alice);
        (canClaim, wait,, reason) = faucet.claimable(alice);
        assertFalse(canClaim);
        assertEq(wait, COOLDOWN);
        assertEq(reason, 4);
    }

    // ---------------- UTC 日切 ----------------

    function test_NewDayResetsSpent() public {
        faucet.claim(alice);
        uint256 day1 = faucet.currentDay();
        assertEq(faucet.spentByDay(day1), AMOUNT);

        // 跨到下一个 UTC 日
        vm.warp((day1 + 1) * 1 days);
        assertEq(faucet.currentDay(), day1 + 1);
        assertEq(faucet.spentByDay(day1 + 1), 0);

        (, uint256 spent, uint256 remaining,,,) = faucet.dailyInfo();
        assertEq(spent, 0);
        assertEq(remaining, CAP);

        faucet.claim(bob);
        assertEq(faucet.spentByDay(day1 + 1), AMOUNT);
        // 上一日的记录仍在（可审计）
        assertEq(faucet.spentByDay(day1), AMOUNT);
    }

    function test_CooldownStillAppliesAcrossDayBoundary() public {
        // 冷却跨 UTC 日切不重置：冷却时长大于一天，日切后仍在冷却窗口内
        LabFaucet slow = new LabFaucet(admin, CAP, AMOUNT, uint32(86400 + 60));
        vm.deal(address(slow), 100 ether);
        slow.claim(alice);
        uint256 day1 = slow.currentDay();
        uint256 last = slow.lastClaimAt(alice);
        vm.warp((day1 + 1) * 1 days); // 恰好跨到下一个 UTC 日零点
        uint256 expectWait = last + 86400 + 60 - block.timestamp;
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.CooldownActive.selector, expectWait));
        slow.claim(alice);
    }

    // ---------------- 治理参数 ----------------

    function test_NonAdminCannotChangePolicy() public {
        vm.prank(alice);
        vm.expectRevert(LabFaucet.NotAdmin.selector);
        faucet.setPolicy(999 ether, 10 ether, 60);
    }

    function test_AdminCanChangePolicy() public {
        vm.prank(admin);
        faucet.setPolicy(1000 ether, 20 ether, 120);
        assertEq(faucet.dailyCap(), 1000 ether);
        assertEq(faucet.amountPerClaim(), 20 ether);
        assertEq(faucet.cooldownSeconds(), 120);
    }

    function test_InvalidPolicyReverts() public {
        vm.prank(admin);
        vm.expectRevert(LabFaucet.InvalidPolicy.selector);
        faucet.setPolicy(100 ether, 200 ether, 60); // cap < 单次金额
        vm.prank(admin);
        vm.expectRevert(LabFaucet.InvalidPolicy.selector);
        faucet.setPolicy(100 ether, 0, 60); // 单次金额为 0
    }

    function test_TransferAdmin() public {
        vm.prank(admin);
        faucet.transferAdmin(bob);
        assertEq(faucet.admin(), bob);
        vm.prank(alice);
        vm.expectRevert(LabFaucet.NotAdmin.selector);
        faucet.setPolicy(1 ether, 1 ether, 1);
    }

    // ---------------- 余额与参数校验 ----------------

    function test_InsufficientBalanceReverts() public {
        vm.deal(address(faucet), 5 ether);
        vm.expectRevert(abi.encodeWithSelector(LabFaucet.InsufficientBalance.selector, 5 ether, AMOUNT));
        faucet.claim(alice);
    }

    function test_ClaimToZeroAddressReverts() public {
        vm.expectRevert(LabFaucet.InvalidAddress.selector);
        faucet.claim(address(0));
    }

    function test_ConstructorRejectsBadParams() public {
        vm.expectRevert(LabFaucet.InvalidPolicy.selector);
        new LabFaucet(admin, 5 ether, 10 ether, 60);
        vm.expectRevert(LabFaucet.InvalidAddress.selector);
        new LabFaucet(address(0), CAP, AMOUNT, COOLDOWN);
    }

    function test_FundIncreasesBalance() public {
        uint256 before = address(faucet).balance;
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        faucet.fund{value: 5 ether}();
        assertEq(address(faucet).balance, before + 5 ether);
        assertEq(alice.balance, 0);
    }

    function test_PlainTransferToContractIsAccepted() public {
        // 没有 receive() 时，普通转账会被 revert 掉（充值失败）；这里锁定这个行为
        uint256 before = address(faucet).balance;
        vm.deal(alice, 3 ether);
        vm.prank(alice);
        (bool ok,) = address(faucet).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(address(faucet).balance, before + 3 ether);
    }
}
