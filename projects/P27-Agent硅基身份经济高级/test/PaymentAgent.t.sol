// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {LabID} from "../src/LabID.sol";
import {LabUSD} from "../src/LabUSD.sol";
import {PaymentAgent} from "../src/PaymentAgent.sol";

/// 支付层：双闸门 min(mandate, tier) / 四道锁 / 执行时点二次校验 / 撤销与过期 / 留痕。
/// tier 置位直接走 SIGNAL_ROLE（本测试合约持有）——信号管线本身的正确性在 SignalRegistry.t.sol 钉死。
contract PaymentAgentTest is Test {
    LabID internal id;
    LabUSD internal usd;
    PaymentAgent internal agent;

    address internal admin = makeAddr("admin");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal runtime = makeAddr("agentRuntime");
    address internal stranger = makeAddr("stranger");

    bytes32 internal agentRole;
    bytes32 internal constant CONDITION = keccak256("bill-due:2026-11");

    function setUp() public {
        vm.warp(1_000_000);
        id = new LabID(admin);
        usd = new LabUSD(admin);
        agent = new PaymentAgent(admin, address(usd), address(id));
        agentRole = agent.AGENT_ROLE();

        vm.startPrank(admin);
        id.grantRole(id.REGISTRAR_ROLE(), admin);
        id.grantRole(id.SIGNAL_ROLE(), address(this));
        id.mint(payer, false, keccak256("kyc"));
        agent.grantRole(agentRole, runtime);
        usd.mint(payer, 1_000_000e6);
        vm.stopPrank();

        vm.prank(payer);
        usd.approve(address(agent), type(uint256).max);
    }

    function _setRep(address who, uint256 rep) internal {
        id.addReputation(who, int256(rep) - int256(id.reputationOf(who)));
    }

    function _mandate(uint256 perTx, uint256 total) internal returns (uint256 mid) {
        vm.prank(payer);
        mid = agent.createMandate(payer, payee, perTx, total, uint64(block.timestamp + 30 days), CONDITION);
    }

    // ============ 授权创建 ============

    function test_CreateMandate_RecordsEffectiveBounds() public {
        _setRep(payer, 500); // T2
        vm.expectEmit(true, true, false, true);
        emit PaymentAgent.MandateCreated(
            1, payer, payee, 1000e6, 3000e6, uint64(block.timestamp + 30 days), CONDITION
        );
        uint256 mid = _mandate(1000e6, 3000e6);
        PaymentAgent.Mandate memory m = agent.mandateOf(mid);
        assertEq(m.payer, payer);
        assertEq(m.payee, payee);
        assertEq(m.perTxLimit, 1000e6);
        assertEq(m.totalLimit, 3000e6);
        assertEq(m.spent, 0);
        assertTrue(m.active);
        assertEq(m.conditionHash, CONDITION);
    }

    function test_CreateMandate_NoIdentityRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.NoLabID.selector, stranger));
        vm.prank(stranger);
        agent.createMandate(stranger, payee, 1e6, 1e6, uint64(block.timestamp + 1 days), CONDITION);
    }

    function test_CreateMandate_T0CannotAuthorize() public {
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.TierTooLow.selector, 0));
        _mandate(100e6, 300e6); // 有身份但 T0：授权都开不出来
    }

    function test_CreateMandate_ClampedToTier() public {
        _setRep(payer, 100); // T1
        uint256 mid = _mandate(10_000e6, 30_000e6); // 申请 T3 额度
        PaymentAgent.Mandate memory m = agent.mandateOf(mid);
        assertEq(m.perTxLimit, 100e6); // 授权不能超越身份等级
        assertEq(m.totalLimit, 300e6);
    }

    function test_CreateMandate_BadParamsRejected() public {
        _setRep(payer, 100);
        uint64 future = uint64(block.timestamp + 1 days);
        vm.startPrank(payer);
        vm.expectRevert(PaymentAgent.BadMandateParams.selector);
        agent.createMandate(payer, payee, 0, 1e6, future, CONDITION);
        vm.expectRevert(PaymentAgent.BadMandateParams.selector);
        agent.createMandate(payer, payee, 2e6, 1e6, future, CONDITION);
        vm.expectRevert(PaymentAgent.BadMandateParams.selector);
        agent.createMandate(payer, payee, 1e6, 1e6, uint64(block.timestamp), CONDITION);
        vm.expectRevert(PaymentAgent.ZeroAddress.selector);
        agent.createMandate(payer, address(0), 1e6, 1e6, future, CONDITION);
        vm.stopPrank();
    }

    function test_CreateMandate_DuplicateRejected() public {
        _setRep(payer, 100);
        _mandate(100e6, 300e6);
        vm.expectPartialRevert(PaymentAgent.DuplicateMandate.selector);
        _mandate(100e6, 300e6);
    }

    // ============ 执行：双闸门与四道锁 ============

    function test_Pay_AgentRoleHappyPath() public {
        _setRep(payer, 2000); // T3
        uint256 mid = _mandate(10_000e6, 30_000e6);
        uint256 payeeBefore = usd.balanceOf(payee);

        vm.expectEmit(true, true, true, true);
        emit PaymentAgent.AgentPaymentExecuted(
            mid, payer, payee, 1500e6, CONDITION, "agent_run:2026-0001", uint64(block.timestamp)
        );
        vm.prank(runtime);
        agent.pay(mid, 1500e6, "agent_run:2026-0001");

        assertEq(usd.balanceOf(payee) - payeeBefore, 1500e6);
        assertEq(usd.balanceOf(payer), 1_000_000e6 - 1500e6);
        assertEq(agent.mandateOf(mid).spent, 1500e6);
        assertEq(agent.remainingAllowance(mid), 28_500e6);
    }

    function test_Pay_PayerSelfCallAllowed() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.prank(payer);
        agent.pay(mid, 50e6, "self:0001");
        assertEq(agent.mandateOf(mid).spent, 50e6);
    }

    function test_Pay_StrangerRejected() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.UnauthorizedPayer.selector, stranger));
        vm.prank(stranger);
        agent.pay(mid, 1e6, "x");
    }

    function test_Pay_PerTxGate() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsPerTxLimit.selector, 101e6, 100e6));
        vm.prank(runtime);
        agent.pay(mid, 101e6, "x");
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsPerTxLimit.selector, 0, 100e6));
        vm.prank(runtime);
        agent.pay(mid, 0, "x");
    }

    function test_Pay_TotalGate() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.startPrank(runtime);
        agent.pay(mid, 100e6, "r1");
        agent.pay(mid, 100e6, "r2");
        agent.pay(mid, 100e6, "r3");
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsTotalLimit.selector, 301e6, 300e6));
        agent.pay(mid, 1e6, "r4");
        vm.stopPrank();
        assertEq(agent.mandateOf(mid).spent, 300e6);
        assertEq(agent.remainingAllowance(mid), 0);
    }

    function test_Pay_UnknownMandateRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.MandateNotFound.selector, 7));
        vm.prank(runtime);
        agent.pay(7, 1e6, "x");
    }

    function test_Pay_RevokedMandateRejected() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.prank(payer);
        agent.revokeMandate(mid);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.MandateInactive.selector, mid));
        vm.prank(runtime);
        agent.pay(mid, 1e6, "x");
    }

    function test_Pay_ExpiredMandateRejected() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.MandateExpired.selector, mid));
        vm.prank(runtime);
        agent.pay(mid, 1e6, "x");
    }

    // ============ 执行时点二次校验：身份降级 → 额度即时收紧 ============

    function test_Pay_TierDowngradeTightensPerTxAndTotal() public {
        _setRep(payer, 500); // T2：1000/3000
        uint256 mid = _mandate(1000e6, 3000e6);
        vm.prank(runtime);
        agent.pay(mid, 500e6, "before-downgrade");

        _setRep(payer, 100); // 降到 T1：100/300

        // 单笔闸门：500 > T1 单笔 100
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsTierLimit.selector, 500e6, 100e6));
        vm.prank(runtime);
        agent.pay(mid, 500e6, "after-downgrade");

        // 累计闸门：已花 500 > T1 累计 300，哪怕单笔 100 合规也付不出
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsTierLimit.selector, 600e6, 300e6));
        vm.prank(runtime);
        agent.pay(mid, 100e6, "after-downgrade");

        assertEq(agent.remainingAllowance(mid), 0);
        assertEq(agent.mandateOf(mid).spent, 500e6); // 历史支出不动，剩余额度归零
    }

    function test_Pay_TierDowngradeToZeroBlocksEverything() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        _setRep(payer, 0); // 声誉清零 → T0
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsTierLimit.selector, 1e6, 0));
        vm.prank(runtime);
        agent.pay(mid, 1e6, "x");
    }

    // ============ 撤销权限 ============

    function test_Revoke_OnlyPayerOrAdmin() public {
        _setRep(payer, 100);
        uint256 mid = _mandate(100e6, 300e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.UnauthorizedRevoker.selector, stranger));
        vm.prank(stranger);
        agent.revokeMandate(mid);
        vm.prank(admin);
        agent.revokeMandate(mid);
        assertFalse(agent.mandateOf(mid).active);
    }

    // ============ 治理 ============

    function test_SetTierLimits_GovernanceOnly() public {
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        vm.prank(stranger);
        agent.setTierLimits(1, 200e6, 600e6);
        vm.prank(admin);
        agent.setTierLimits(1, 200e6, 600e6);
        assertEq(agent.tierPerTxLimit(1), 200e6);
        assertEq(agent.tierTotalLimit(1), 600e6);
        vm.expectRevert(PaymentAgent.BadMandateParams.selector);
        vm.prank(admin);
        agent.setTierLimits(4, 1, 1);
    }

    function test_Constructor_ZeroAddressRejected() public {
        vm.expectRevert(PaymentAgent.ZeroAddress.selector);
        new PaymentAgent(address(0), address(usd), address(id));
        vm.expectRevert(PaymentAgent.ZeroAddress.selector);
        new PaymentAgent(admin, address(0), address(id));
        vm.expectRevert(PaymentAgent.ZeroAddress.selector);
        new PaymentAgent(admin, address(usd), address(0));
    }

    function test_Views_UnknownMandate() public {
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.MandateNotFound.selector, 9));
        agent.mandateOf(9);
        assertEq(agent.remainingAllowance(9), 0);
    }

    // ============ fuzz：双闸门语义 ============

    function testFuzz_DoubleGateMinSemantics(uint256 amount) public {
        amount = bound(amount, 0, 1000e6);
        _setRep(payer, 100); // T1：100/300；mandate 申请 100/300 → 两边一致
        uint256 mid = _mandate(100e6, 300e6);
        bool shouldPass = amount > 0 && amount <= 100e6;
        if (shouldPass) {
            vm.prank(runtime);
            agent.pay(mid, amount, "fuzz");
            assertEq(agent.mandateOf(mid).spent, amount);
        } else {
            vm.expectPartialRevert(PaymentAgent.ExceedsPerTxLimit.selector);
            vm.prank(runtime);
            agent.pay(mid, amount, "fuzz");
        }
    }

    function testFuzz_ClampNeverExceedsTier(uint256 perTx, uint256 total) public {
        perTx = bound(perTx, 1, 1_000_000e6);
        total = bound(total, perTx, 10_000_000e6);
        _setRep(payer, 500); // T2：1000/3000
        uint256 mid = _mandate(perTx, total);
        PaymentAgent.Mandate memory m = agent.mandateOf(mid);
        assertLe(m.perTxLimit, 1000e6);
        assertLe(m.totalLimit, 3000e6);
        assertEq(m.perTxLimit, perTx < 1000e6 ? perTx : 1000e6);
        assertEq(m.totalLimit, total < 3000e6 ? total : 3000e6);
    }
}
