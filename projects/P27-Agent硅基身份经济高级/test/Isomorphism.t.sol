// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabID} from "../src/LabID.sol";
import {LabUSD} from "../src/LabUSD.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {PaymentAgent} from "../src/PaymentAgent.sol";

/// 碳基 × 硅基同构：同一套信号协议、同一张 tier 表、同一组闸门——不豁免、不歧视。
/// 与单元测试不同，这里 tier 全部由真实信号管线（commit → 3/5 确认）积累而来。
contract IsomorphismTest is Test {
    LabID internal id;
    LabUSD internal usd;
    SignalRegistry internal reg;
    PaymentAgent internal agent;

    address internal admin = makeAddr("admin");
    address internal provider = makeAddr("provider");
    address internal runtime = makeAddr("agentRuntime");
    address internal human = makeAddr("human");
    address internal silicon = makeAddr("siliconAgent");
    address internal payee = makeAddr("payee");

    uint256[5] internal verifierPks;
    bytes32 internal constant CONDITION = keccak256("inventory-below-threshold");

    function setUp() public {
        vm.warp(1_000_000);
        id = new LabID(admin);
        usd = new LabUSD(admin);
        reg = new SignalRegistry(admin, address(id));
        agent = new PaymentAgent(admin, address(usd), address(id));

        vm.startPrank(admin);
        id.grantRole(id.SIGNAL_ROLE(), address(reg));
        id.grantRole(id.SIGNAL_ROLE(), address(this)); // 降级演练用（罚没语义，见 docs/01）
        id.grantRole(id.REGISTRAR_ROLE(), admin);
        reg.grantRole(reg.PROVIDER_ROLE(), provider);
        agent.grantRole(agent.AGENT_ROLE(), runtime);
        for (uint256 i; i < 5; ++i) {
            verifierPks[i] = 0xC0FFEE + i;
            reg.addVerifier(vm.addr(verifierPks[i]));
        }
        id.mint(human, false, keccak256("human-kyc"));
        id.mint(silicon, true, keccak256("agent-kyc"));
        usd.mint(human, 100_000e6);
        usd.mint(silicon, 100_000e6);
        vm.stopPrank();

        vm.prank(human);
        usd.approve(address(agent), type(uint256).max);
        vm.prank(silicon);
        usd.approve(address(agent), type(uint256).max);
    }

    /// 一条信号走完整管线：provider 承诺 + 3/5 验证者确认。
    function _signal(address subject, uint8 kind, uint256 salt) internal {
        bytes32 sigHash = keccak256(abi.encodePacked(subject, kind, salt));
        vm.prank(provider);
        uint256 cid = reg.commit(subject, "agent:runtime", sigHash, kind, uint64(block.timestamp));
        SignalRegistry.Commitment memory c = reg.commitmentOf(cid);
        bytes32 inner =
            keccak256(abi.encodePacked("LabSignal-Confirm", cid, c.subject, c.sigHash, uint8(c.kind), c.ts));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPks[i], digest);
            reg.confirm(cid, abi.encodePacked(r, s, v));
        }
    }

    function _mandate(address payer, uint256 perTx, uint256 total) internal returns (uint256 mid) {
        vm.prank(payer);
        mid = agent.createMandate(payer, payee, perTx, total, uint64(block.timestamp + 30 days), CONDITION);
    }

    // ============ 出生同构 ============

    function test_BothBornT0_BothCannotAuthorize() public {
        assertEq(id.tierOf(human), 0);
        assertEq(id.tierOf(silicon), 0);
        assertTrue(id.identityOf(id.idOf(silicon)).isAgent);
        assertFalse(id.identityOf(id.idOf(human)).isAgent);

        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.TierTooLow.selector, 0));
        _mandate(human, 100e6, 300e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.TierTooLow.selector, 0));
        _mandate(silicon, 100e6, 300e6); // T0 的 Agent 一样开不出授权
    }

    function test_AgentIdentityIsSoulboundToo() public {
        uint256 tokenId = id.idOf(silicon);
        vm.expectRevert(LabID.Soulbound.selector);
        vm.prank(silicon);
        id.transferFrom(silicon, human, tokenId);
    }

    // ============ 积累同构：同一权重表、同一阈值 ============

    function test_SameProtocolSameTier() public {
        for (uint256 i; i < 5; ++i) {
            _signal(silicon, 3, i); // AgentFingerprint ×5 = 100
        }
        for (uint256 i; i < 10; ++i) {
            _signal(human, 0, i); // Behavioral ×10 = 100
        }
        assertEq(id.reputationOf(silicon), 100);
        assertEq(id.reputationOf(human), 100);
        assertEq(id.tierOf(silicon), 1);
        assertEq(id.tierOf(human), 1);
    }

    function test_BelowThresholdBothBlocked() public {
        for (uint256 i; i < 4; ++i) {
            _signal(silicon, 3, i); // 80
        }
        _signal(silicon, 0, 99); // +10 = 90
        for (uint256 i; i < 9; ++i) {
            _signal(human, 0, i); // 90
        }
        assertEq(id.tierOf(silicon), 0);
        assertEq(id.tierOf(human), 0);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.TierTooLow.selector, 0));
        _mandate(silicon, 1e6, 1e6);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.TierTooLow.selector, 0));
        _mandate(human, 1e6, 1e6);
    }

    function test_SameTierSameCaps() public {
        for (uint256 i; i < 5; ++i) {
            _signal(silicon, 3, i);
        }
        for (uint256 i; i < 10; ++i) {
            _signal(human, 0, i);
        }
        uint256 midH = _mandate(human, 10_000e6, 30_000e6);
        uint256 midA = _mandate(silicon, 10_000e6, 30_000e6);
        PaymentAgent.Mandate memory mh = agent.mandateOf(midH);
        PaymentAgent.Mandate memory ma = agent.mandateOf(midA);
        assertEq(mh.perTxLimit, ma.perTxLimit);
        assertEq(mh.totalLimit, ma.totalLimit);
        assertEq(ma.perTxLimit, 100e6);
    }

    // ============ 硅基端到端：信号 → T3 → 授权 → 免用户操作代付 ============

    function test_AgentT3_EndToEndAutonomousPayment() public {
        for (uint256 i; i < 100; ++i) {
            _signal(silicon, 3, i); // AgentFingerprint ×100 = 2000 → T3
        }
        assertEq(id.tierOf(silicon), 3);

        uint256 mid = _mandate(silicon, 10_000e6, 30_000e6);
        uint256 payeeBefore = usd.balanceOf(payee);

        // Agent 运行时在边界内自主执行，用户零操作；reasonRef 指向链下决策日志
        vm.expectEmit(true, true, true, true);
        emit PaymentAgent.AgentPaymentExecuted(
            mid, silicon, payee, 1500e6, CONDITION, "agent_run:2026-0042", uint64(block.timestamp)
        );
        vm.prank(runtime);
        agent.pay(mid, 1500e6, "agent_run:2026-0042");

        assertEq(usd.balanceOf(payee) - payeeBefore, 1500e6);
        assertEq(agent.mandateOf(mid).spent, 1500e6);
        assertEq(agent.remainingAllowance(mid), 28_500e6);
    }

    function test_HumanT1_EndToEndSymmetric() public {
        for (uint256 i; i < 10; ++i) {
            _signal(human, 0, i);
        }
        uint256 mid = _mandate(human, 100e6, 300e6);
        vm.prank(runtime);
        agent.pay(mid, 100e6, "agent_run:human-0001");
        assertEq(usd.balanceOf(payee), 100e6);
    }

    // ============ 降级同构：罚没对硅基同样即时生效 ============

    function test_DowngradeAppliesToAgentToo() public {
        for (uint256 i; i < 25; ++i) {
            _signal(silicon, 3, i); // 500 → T2
        }
        uint256 mid = _mandate(silicon, 1000e6, 3000e6);
        vm.prank(runtime);
        agent.pay(mid, 500e6, "before");

        id.addReputation(silicon, -400); // 罚没 → rep 100 → T1
        assertEq(id.tierOf(silicon), 1);
        assertEq(agent.remainingAllowance(mid), 0); // 已花 500 > T1 累计 300

        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.ExceedsTierLimit.selector, 600e6, 300e6));
        vm.prank(runtime);
        agent.pay(mid, 100e6, "after");
    }

    function test_AgentMandateRevocableByPayer() public {
        for (uint256 i; i < 5; ++i) {
            _signal(silicon, 3, i);
        }
        uint256 mid = _mandate(silicon, 100e6, 300e6);
        vm.prank(silicon);
        agent.revokeMandate(mid);
        vm.expectRevert(abi.encodeWithSelector(PaymentAgent.MandateInactive.selector, mid));
        vm.prank(runtime);
        agent.pay(mid, 1e6, "x");
    }
}
