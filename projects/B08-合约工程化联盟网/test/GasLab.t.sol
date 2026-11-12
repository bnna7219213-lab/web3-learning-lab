// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {GasLab} from "../src/GasLab.sol";

/// @notice P8-S2b：GasLab 四组 naive vs optimized 对照——同交易内 gasleft() 对账
/// @dev 口径：记录的是 gas 消耗（gasUsed），不是「费用」（README 零 gas 语义校准）。
contract GasLabTest is Test {
    GasLab internal lab;

    uint256 internal constant N = 64;

    function setUp() public {
        lab = new GasLab(N);
    }

    function _g1_storageReadInLoop() internal view returns (uint256 naive, uint256 cached) {
        // 预热：首调用要付冷访问成本（SLOAD 冷 2100 vs 热 100），不预热会把
        // cold/warm 时序差异算进「算法差异」——测量方法先对齐，再比两版实现
        lab.sumNaive();
        lab.sumCached();

        uint256 g0 = gasleft();
        uint256 r1 = lab.sumNaive();
        naive = g0 - gasleft();

        uint256 g1 = gasleft();
        uint256 r2 = lab.sumCached();
        cached = g1 - gasleft();

        assertEq(r1, r2, unicode"两版求和结果必须一致");
        assertEq(r1, N * (N + 1) / 2, unicode"求和结果错误");
    }

    function test_group1_storageReadCache() public {
        (uint256 naive, uint256 cached) = _g1_storageReadInLoop();
        console.log(unicode"[组1 缓存读] naive:", naive);
        console.log(unicode"[组1 缓存读] cached:", cached);
        assertLt(cached, naive, unicode"缓存读应更省");
    }

    function test_group2_calldataVsMemory() public view {
        uint256[] memory xs = new uint256[](128);
        for (uint256 i = 0; i < xs.length; ++i) {
            xs[i] = i;
        }

        uint256 g0 = gasleft();
        uint256 r1 = lab.countNaive(xs);
        uint256 naive = g0 - gasleft();

        uint256 g1 = gasleft();
        uint256 r2 = lab.countCalldata(xs);
        uint256 calldataGas = g1 - gasleft();

        assertEq(r1, r2, unicode"计数结果必须一致");
        assertEq(r1, 64, unicode"偶数应为 64 个");
        console.log(unicode"[组2 calldata] naive(拷memory):", naive);
        console.log(unicode"[组2 calldata] calldata直读:", calldataGas);
        assertLt(calldataGas, naive, unicode"calldata 直读应更省");
    }

    function test_group3_uncheckedLoop() public {
        uint256 rounds = 500;

        // 预热 total 槽（与组1 同理：先把冷/热时序差异从算法差异里剥离）
        lab.accumulateChecked(1);
        lab.accumulateUnchecked(1);

        uint256 g0 = gasleft();
        lab.accumulateChecked(rounds);
        uint256 checkedGas = g0 - gasleft();

        uint256 g1 = gasleft();
        lab.accumulateUnchecked(rounds);
        uint256 uncheckedGas = g1 - gasleft();

        console.log(unicode"[组3 unchecked] checked:", checkedGas);
        console.log(unicode"[组3 unchecked] unchecked:", uncheckedGas);
        assertLt(uncheckedGas, checkedGas, unicode"unchecked 应更省");

        // 负例：不设界的版本在 rounds 溢出时必须 revert（0.8 自带检查生效）
        vm.expectRevert();
        this.accumulateNoGuard(type(uint256).max);
    }

    /// @dev 反证：若去掉 require 直接 unchecked，rounds=uint256.max 会死循环/结果错误——
    ///      这里用「有 require 的版本」证明界已挡住溢出。
    function accumulateNoGuard(uint256 rounds) external returns (uint256) {
        return lab.accumulateUnchecked(rounds);
    }

    function test_group3_negative_overflowGuard() public {
        vm.expectRevert(bytes("rounds too big"));
        lab.accumulateUnchecked(uint256(type(uint64).max) + 1);
    }

    function test_group4_singleSlotCredit() public {
        // 预热 total 槽：否则首写付冷 SSTORE 20k、后写付热更新 100，测的是时序不是实现
        lab.creditNaive(1);
        lab.creditCached(1);

        uint256 g0 = gasleft();
        lab.creditNaive(5);
        uint256 naive = g0 - gasleft();

        uint256 g1 = gasleft();
        lab.creditCached(7);
        uint256 cached = g1 - gasleft();

        console.log(unicode"[组4 单槽写] naive(SLOAD+SSTORE 内联):", naive);
        console.log(unicode"[组4 单槽写] cached(局部变量):", cached);
        assertEq(lab.total(), 1 + 1 + 5 + 7, unicode"两版 credit 语义必须一致");
        // 预热后的诚实结论：单次读写两版几乎无差（solc 0.8.28 内联优化已等价），
        // 「缓存读」的收益只出现在多次读（组1 循环：33420 → 26947）。
        // 若此处断言 cached 明显更省，就是把冷/热时序当成了算法差异——方法论见 docs/01
        assertApproxEqAbs(
            cached, naive, 200, unicode"单次读写两版应接近（差值仅在多次读场景显现）"
        );
    }

    // ── 整体 gas report 由 `forge test --gas-report` 输出，入 docs/01 ─────────
    function test_report_smoke() public {
        lab.creditNaive(1);
        assertGt(lab.total(), 0);
    }
}
