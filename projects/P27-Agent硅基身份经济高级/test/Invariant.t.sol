// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabID} from "../src/LabID.sol";
import {LabUSD} from "../src/LabUSD.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {PaymentAgent} from "../src/PaymentAgent.sol";

/// 随机动作序列下的系统不变式：支出不越授权 / tier 与声誉一致 / 身份不可转让 / 资金守恒。
contract P27Handler is Test {
    LabID public id;
    LabUSD public usd;
    SignalRegistry public reg;
    PaymentAgent public agent;

    address public human;
    address public silicon;
    address public payee;
    address public runtime;
    address public provider;
    uint256[5] public verifierPks;
    uint256 public nonce;

    constructor(
        LabID id_,
        LabUSD usd_,
        SignalRegistry reg_,
        PaymentAgent agent_,
        address[3] memory subjects,
        address runtime_,
        address provider_,
        uint256[5] memory pks
    ) {
        id = id_;
        usd = usd_;
        reg = reg_;
        agent = agent_;
        human = subjects[0];
        silicon = subjects[1];
        payee = subjects[2];
        runtime = runtime_;
        provider = provider_;
        verifierPks = pks;
    }

    function _subject(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? human : silicon;
    }

    function signal(uint256 subjectSeed, uint256 kindSeed) public {
        address subject = _subject(subjectSeed);
        uint8 kind = uint8(kindSeed % 4);
        bytes32 sigHash = keccak256(abi.encodePacked(subject, kind, nonce++));
        vm.prank(provider);
        uint256 cid = reg.commit(subject, "agent:runtime", sigHash, kind, uint64(block.timestamp));
        bytes32 inner =
            keccak256(abi.encodePacked("LabSignal-Confirm", cid, subject, sigHash, kind, uint64(block.timestamp)));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierPks[i], digest);
            reg.confirm(cid, abi.encodePacked(r, s, v));
        }
    }

    function createMandate(uint256 subjectSeed, uint256 perTx, uint256 total) public {
        address payer = _subject(subjectSeed);
        perTx = bound(perTx, 1, 20_000e6);
        total = bound(total, perTx, 60_000e6);
        vm.prank(payer);
        agent.createMandate(
            payer, payee, perTx, total, uint64(block.timestamp + 30 days), keccak256(abi.encodePacked("c", nonce++))
        );
    }

    function pay(uint256 midSeed, uint256 amount) public {
        uint256 count = agent.mandateCount();
        if (count == 0) return;
        uint256 mid = (midSeed % count) + 1;
        amount = bound(amount, 0, 2000e6);
        vm.prank(runtime);
        agent.pay(mid, amount, "invariant");
    }

    function slash(uint256 subjectSeed, uint256 delta) public {
        delta = bound(delta, 0, 3000);
        id.addReputation(_subject(subjectSeed), -int256(delta));
    }

    function revoke(uint256 midSeed) public {
        uint256 count = agent.mandateCount();
        if (count == 0) return;
        uint256 mid = (midSeed % count) + 1;
        address payer = agent.mandateOf(mid).payer;
        vm.prank(payer);
        agent.revokeMandate(mid);
    }
}

contract InvariantTest is Test {
    LabID internal id;
    LabUSD internal usd;
    SignalRegistry internal reg;
    PaymentAgent internal agent;
    P27Handler internal handler;

    address internal admin = makeAddr("admin");
    address internal human = makeAddr("human");
    address internal silicon = makeAddr("silicon");
    address internal payee = makeAddr("payee");
    address internal runtime = makeAddr("runtime");
    address internal provider = makeAddr("provider");

    function setUp() public {
        vm.warp(1_000_000);
        id = new LabID(admin);
        usd = new LabUSD(admin);
        reg = new SignalRegistry(admin, address(id));
        agent = new PaymentAgent(admin, address(usd), address(id));

        uint256[5] memory pks;
        vm.startPrank(admin);
        id.grantRole(id.SIGNAL_ROLE(), address(reg));
        id.grantRole(id.REGISTRAR_ROLE(), admin);
        reg.grantRole(reg.PROVIDER_ROLE(), provider);
        agent.grantRole(agent.AGENT_ROLE(), runtime);
        for (uint256 i; i < 5; ++i) {
            pks[i] = 0xD00D + i;
            reg.addVerifier(vm.addr(pks[i]));
        }
        id.mint(human, false, keccak256("h"));
        id.mint(silicon, true, keccak256("a"));
        usd.mint(human, 1_000_000e6);
        usd.mint(silicon, 1_000_000e6);
        vm.stopPrank();

        vm.prank(human);
        usd.approve(address(agent), type(uint256).max);
        vm.prank(silicon);
        usd.approve(address(agent), type(uint256).max);

        handler = new P27Handler(id, usd, reg, agent, [human, silicon, payee], runtime, provider, pks);
        bytes32 signalRole = id.SIGNAL_ROLE(); // 先读常量：vm.prank 会被中间的外部 view 调用消耗（P05 坑 #5）
        vm.prank(admin);
        id.grantRole(signalRole, address(handler)); // 罚没动作

        targetContract(address(handler));
    }

    /// 任何 mandate 的累计支出都不能超过其（已被 tier 钳制的）总额上限。
    function invariant_SpentNeverExceedsMandateTotal() public view {
        uint256 count = agent.mandateCount();
        for (uint256 mid = 1; mid <= count; ++mid) {
            PaymentAgent.Mandate memory m = agent.mandateOf(mid);
            assertLe(m.spent, m.totalLimit);
        }
    }

    /// tier 永远等于声誉阈值的推导结果（升级/罚没后都成立）。
    function invariant_TierMatchesReputation() public view {
        address[2] memory subjects = [human, silicon];
        for (uint256 i; i < 2; ++i) {
            uint256 rep = id.reputationOf(subjects[i]);
            uint8 want = rep >= 2000 ? 3 : rep >= 500 ? 2 : rep >= 100 ? 1 : 0;
            assertEq(id.tierOf(subjects[i]), want);
        }
    }

    /// soulbound：身份归属永不改变。
    function invariant_SoulboundOwnership() public view {
        assertEq(id.ownerOf(id.idOf(human)), human);
        assertEq(id.ownerOf(id.idOf(silicon)), silicon);
    }

    /// 资金守恒：代付只搬钱，不造钱。
    function invariant_TokenConservation() public view {
        assertEq(usd.balanceOf(human) + usd.balanceOf(silicon) + usd.balanceOf(payee), usd.totalSupply());
    }
}
