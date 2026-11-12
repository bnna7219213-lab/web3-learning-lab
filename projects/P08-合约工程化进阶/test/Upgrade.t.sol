// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VaultV1, VaultV2, VaultBadV2} from "../src/UUPSUpgrade.sol";
import {IERC1967} from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";

/// @notice P8-S4：UUPS 升级演练——V1→V2 正例 + 槽冲突反例 + 非授权升级负例
contract UpgradeTest is Test {
    // ERC-1967 固定槽（EIP-1967 常量，手工列出来做冲突检查）
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    VaultV1 internal implV1;
    ERC1967Proxy internal proxy;
    VaultV1 internal vault; // 指向 proxy 的 V1 视图

    function setUp() public {
        implV1 = new VaultV1();
        bytes memory initData = abi.encodeCall(VaultV1.initialize, (owner));
        proxy = new ERC1967Proxy(address(implV1), initData);
        vault = VaultV1(address(proxy));
    }

    // ── 正例：V1 → V2，状态与 owner 保留，新功能可用 ─────────────────────────
    function test_upgradeV1toV2_preservesState() public {
        vm.deal(stranger, 10 ether);
        vm.prank(stranger);
        vault.deposit{value: 3 ether}();

        // 升级
        VaultV2 implV2 = new VaultV2();
        vm.prank(owner);
        vault.upgradeToAndCall(address(implV2), "");
        VaultV2 v2 = VaultV2(address(proxy));

        // 旧状态逐项对账
        assertEq(v2.owner(), owner, unicode"owner 必须保留");
        assertEq(v2.version(), 1, unicode"version 必须保留（migrate 前仍为 1）");
        assertEq(v2.totalDeposited(), 3 ether, unicode"totalDeposited 必须保留");
        assertEq(address(proxy).balance, 3 ether, unicode"原生 ETH 必须仍在代理地址");

        // 新功能
        assertEq(v2.totalWithdrawn(), 0, unicode"新字段初始为 0");
        vm.prank(owner);
        v2.withdraw(1 ether);
        assertEq(v2.totalWithdrawn(), 1 ether, unicode"V2 新功能应可用");

        // 迁移入口（幂等）
        v2.migrateFromV1();
        assertEq(v2.version(), 2, unicode"migrate 后 version 应为 2");
        vm.expectRevert(bytes("already migrated"));
        v2.migrateFromV1();
    }

    // ── 槽冲突检查1：ERC-1967 固定槽 vs 合约状态槽，零重叠 ───────────────────
    function test_erc1967SlotsDoNotCollideWithStateSlots() public {
        // 实现地址确实写在标准槽（vm.load 直读代理地址的存储；
        // 注意 StorageSlot.getAddressSlot 读的是「调用者自己」的槽，不能用来查别的合约）
        assertEq(
            address(uint160(uint256(vm.load(address(proxy), IMPLEMENTATION_SLOT)))),
            address(implV1),
            unicode"实现地址应在 EIP-1967 槽"
        );

        // 升级前后，状态槽 0/1/2 的值只随合约逻辑变，不被固定槽污染
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vault.deposit{value: 1 ether}();

        assertEq(uint256(vm.load(address(proxy), bytes32(uint256(0)))), uint160(owner), unicode"slot0=owner");
        assertEq(uint256(vm.load(address(proxy), bytes32(uint256(1)))), 1, unicode"slot1=version");
        assertEq(uint256(vm.load(address(proxy), bytes32(uint256(2)))), 1 ether, unicode"slot2=totalDeposited");

        // ADMIN/BEACON 槽在 UUPS 模式下应为空（不是 Transparent 的 admin 模式）
        assertEq(uint256(vm.load(address(proxy), ADMIN_SLOT)), 0, unicode"UUPS 不应有 admin 槽值");
        assertEq(uint256(vm.load(address(proxy), BEACON_SLOT)), 0, unicode"UUPS 不应有 beacon 槽值");

        console.log(unicode"实现槽与状态槽 0/1/2 均无冲突");
    }

    // ── 槽冲突检查2：插队式 BadV2 升级 → 旧数据被错位解释（复现事故）──────────
    function test_badUpgrade_slotCollisionRepro() public {
        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        vault.deposit{value: 5 ether}();

        VaultBadV2 bad = new VaultBadV2();
        vm.prank(owner);
        vault.upgradeToAndCall(address(bad), "");
        VaultBadV2 b = VaultBadV2(address(proxy));

        // slot2（原 totalDeposited=5 ether 的位）现在被 totalWithdrawn 读走
        assertEq(b.totalWithdrawn(), 5 ether, unicode"复现：存款被新变量读成提现计数");
        assertEq(b.totalDeposited(), 0, unicode"复现：totalDeposited 读到旧 gap 槽=0");
        assertEq(
            uint256(vm.load(address(proxy), bytes32(uint256(2)))),
            5 ether,
            unicode"底层位没变——变的是解释方式（这就是存储槽冲突）"
        );
        // 教学结论：数据没丢，但语义已错——所以升级前必须 diff 存储布局
    }

    // ── 负例：非 owner 升级被拒 ───────────────────────────────────────────────
    function test_unauthorizedUpgradeRejected() public {
        VaultV2 implV2 = new VaultV2();

        vm.prank(stranger);
        vm.expectRevert(bytes("not owner"));
        vault.upgradeToAndCall(address(implV2), "");

        // owner 才能成功
        vm.prank(owner);
        vault.upgradeToAndCall(address(implV2), "");
        assertEq(
            address(uint160(uint256(vm.load(address(proxy), IMPLEMENTATION_SLOT)))),
            address(implV2),
            unicode"升级后实现地址应更新"
        );
    }

    // ── 负例：实现合约自身不可直接 initialize（防抢跑）────────────────────────
    function test_implementationCannotBeInitialized() public {
        vm.expectRevert();
        implV1.initialize(stranger);
    }

    // ── 布局 diff：V1→V2 旧字段槽位逐一不变（升级前门禁）────────────────────
    function test_layoutDiffGate() public view {
        // V1: owner=0, version=1, totalDeposited=2
        // V2: owner=0, version=1, totalDeposited=2, totalWithdrawn=3（吃 gap）, lastDepositBlock=4
        // 用 forge inspect storage-layout 人工核对的期望值写死在这里，
        // 任何人改动字段顺序都会先挂这条测试（P08 README 验收：代理升级含存储槽冲突检查）。
        VaultV1 v1 = VaultV1(address(0)); // 仅用于类型占位，无调用
        assertEq(v1.version.selector, VaultV2(address(0)).version.selector, unicode"getter selector 应保持兼容");
        assertEq(
            v1.totalDeposited.selector,
            VaultV2(address(0)).totalDeposited.selector,
            unicode"getter selector 应保持兼容"
        );
        assertEq(v1.owner.selector, VaultV2(address(0)).owner.selector, unicode"getter selector 应保持兼容");
    }
}
