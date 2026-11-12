// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {StorageLayoutDemo, StorageSplitDemo} from "../src/StorageLayoutDemo.sol";

/// @notice P8-S2a：slot 手工计算 vs vm.load 实测对账 + 打包/拆槽写成本对照
contract StorageLayoutTest is Test {
    StorageLayoutDemo internal demo;
    StorageSplitDemo internal split;

    address internal alice = makeAddr("alice");

    function setUp() public {
        demo = new StorageLayoutDemo();
        split = new StorageSplitDemo();
    }

    // ── slot 0：uint128 | uint64 | bool 的位布局 ─────────────────────────────
    function test_slot0_manualLayout() public {
        demo.setPacked(0xdead, 0xbeef, true);

        uint256 expected = uint256(uint128(0xdead)) | (uint256(uint64(0xbeef)) << 128) | (uint256(1) << 192);
        bytes32 raw = vm.load(address(demo), bytes32(uint256(0)));

        assertEq(uint256(raw), expected, unicode"slot0 位布局与手工推算不一致");
        // 逐字段抽取
        assertEq(uint256(raw) & type(uint128).max, 0xdead, unicode"a 应在 [0..127]");
        assertEq((uint256(raw) >> 128) & type(uint64).max, 0xbeef, unicode"b 应在 [128..191]");
        assertEq((uint256(raw) >> 192) & 0xff, 1, unicode"flag 应在 [192..199]");
        console.log(unicode"slot0 原始值:", vm.toString(raw));
    }

    // ── slot 1：address(160) + uint96(96) = 256 正好占满 ─────────────────────
    function test_slot1_addressNoncePacking() public {
        demo.setOwner(alice);

        bytes32 raw = vm.load(address(demo), bytes32(uint256(1)));
        uint256 expected = uint256(uint160(alice)) | (uint256(1) << 160); // nonce 初始 0 → 自增为 1

        assertEq(uint256(raw), expected, unicode"slot1 owner+nonce 打包与手工推算不一致");
        assertEq(address(uint160(uint256(raw) & type(uint160).max)), alice, unicode"owner 在 [0..159]");
        assertEq(uint256(raw) >> 160, 1, unicode"nonce 在 [160..255]");
    }

    // ── mapping 槽：keccak256(abi.encode(key, slot)) ─────────────────────────
    function test_mappingSlotManualDerivation() public {
        vm.prank(alice);
        demo.credit(777);

        bytes32 slot = keccak256(abi.encode(alice, uint256(3)));
        bytes32 raw = vm.load(address(demo), slot);

        assertEq(uint256(raw), 777, unicode"mapping 数据槽推算错误");
        assertEq(demo.balances(alice), 777, unicode"getter 与手工槽位读数不一致");
        console.log(unicode"mapping 槽:", vm.toString(slot));
    }

    // ── 拆槽版：确认垫片生效，三个字段落在不同 slot ───────────────────────────
    function test_splitLayoutForcedByPadding() public {
        split.setSplit(1, 2, true);

        // a → slot 0；b → slot 2；flag → slot 4（_pad1/_pad2 各占满一个槽，强制拆开）
        assertEq(
            uint256(vm.load(address(split), bytes32(uint256(0)))) & type(uint128).max,
            1,
            unicode"a 应在 slot0 低位"
        );
        assertEq(uint256(vm.load(address(split), bytes32(uint256(2)))), 2, unicode"b 独占 slot2");
        assertEq(uint256(vm.load(address(split), bytes32(uint256(4)))) & 0xff, 1, unicode"flag 应在 slot4");
        // 同交易内三次独立冷 SSTORE（20k×3） vs 打包版一次冷 SSTORE（20k）——见下方 gas 对照
    }

    // ── 冷 SSTORE 成本对照：打包写 vs 拆槽写（同一交易内各自首写）──────────
    function test_gas_packedWriteVsSplitWrite() public {
        uint256 g0 = gasleft();
        demo.setPacked(1, 2, true);
        uint256 gasPacked = g0 - gasleft();

        uint256 g1 = gasleft();
        split.setSplit(1, 2, true);
        uint256 gasSplit = g1 - gasleft();

        console.log(unicode"打包写 gasUsed:", gasPacked);
        console.log(unicode"拆槽写 gasUsed:", gasSplit);
        assertLt(gasPacked, gasSplit, unicode"打包写应更省 gas");
        // 冷 SSTORE 20000/次：3 次 ≈ 60k+，打包首写一次 20k——差值应 > 30k
        assertGt(gasSplit - gasPacked, 30_000, unicode"拆槽多出的冷 SSTORE 成本应 > 30k");
    }

    // ── forge inspect 对账：源码声明顺序 = 链上布局（防意外重排）─────────────
    function test_layoutInvariants() public {
        // demo 的 counter 必须在 slot 2（owner+nonce 占满 slot1 后顺延）
        // 用 getter 存在性 + vm.load slot2 间接确认编译器没插额外槽
        assertEq(demo.counter(), 0);
        demo.bumpCounter();
        assertEq(uint256(vm.load(address(demo), bytes32(uint256(2)))), 1, unicode"counter 应在 slot2");
    }
}
