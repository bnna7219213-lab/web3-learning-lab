// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Create2Factory, Beacon} from "../src/Create2Factory.sol";

/// @notice P8-S3：CREATE2 确定性地址——公式对账 + 三个输入的变体负例
contract Create2Test is Test {
    Create2Factory internal factory;

    function setUp() public {
        factory = new Create2Factory();
    }

    function _initCode(uint256 tag) internal pure returns (bytes memory) {
        return abi.encodePacked(type(Beacon).creationCode, abi.encode(tag));
    }

    // ── 正例：链下预计算 == 链上 create2 实际地址 ─────────────────────────────
    function test_precomputedMatchesOnchain() public {
        bytes32 salt = keccak256("p08/beacon/v1");
        bytes memory initCode = _initCode(1);

        address predicted = factory.computeAddress(salt, keccak256(initCode));
        address actual = factory.deploy(salt, initCode);

        assertEq(actual, predicted, unicode"链上地址 != 链下预计算");
        assertEq(actual, factory.deployedBySalt(salt), unicode"记录与实部署不一致");
        console.log(unicode"预测地址 == 实际地址:", vm.toString(actual));
    }

    // ── 负例1：salt 变 → 地址全变（与 EIP-1014 一致）────────────────────────
    function test_saltChangeChangesAddress() public {
        bytes memory initCode = _initCode(1);
        bytes32 h = keccak256(initCode);

        address a1 = factory.computeAddress(keccak256("salt-A"), h);
        address a2 = factory.computeAddress(keccak256("salt-B"), h);

        assertTrue(a1 != a2, unicode"不同 salt 必须得不同地址");
        // 实部署验证一次
        address onchain = factory.deploy(keccak256("salt-A"), initCode);
        assertEq(onchain, a1, unicode"salt-A 实部署与预计算不符");
    }

    // ── 负例2：initCode 变（构造参数不同）→ 地址全变 ────────────────────────
    function test_initCodeChangeChangesAddress() public {
        bytes32 salt = keccak256("p08/beacon/shared-salt");

        address withTag1 = factory.computeAddress(salt, keccak256(_initCode(1)));
        address withTag2 = factory.computeAddress(salt, keccak256(_initCode(2)));

        assertTrue(withTag1 != withTag2, unicode"构造参数不同必须得不同地址");
        // 实部署 tag=1 版
        assertEq(factory.deploy(salt, _initCode(1)), withTag1, unicode"实部署与预计算不符");
        // 同 salt 同 initCode 重复部署 → 必须拒绝（CREATE2 天然撞地址）
        vm.expectRevert(abi.encodeWithSelector(Create2Factory.AddressAlreadyUsed.selector, salt));
        factory.deploy(salt, _initCode(1));
    }

    // ── 负例3：工厂地址变 → 地址全变（0xff ++ factory 参与哈希）──────────────
    function test_factoryAddressChangeChangesAddress() public {
        Create2Factory other = new Create2Factory();
        bytes32 salt = keccak256("p08/beacon/v1");
        bytes32 h = keccak256(_initCode(1));

        assertTrue(
            factory.computeAddress(salt, h) != other.computeAddress(salt, h),
            unicode"不同工厂必须得不同地址"
        );
    }

    // ── 交互式对账：与 vm.computeCreate2Address（forge 官方公式）互证 ────────
    function test_crossCheckVmFormula() public {
        bytes32 salt = keccak256("p08/cross");
        bytes memory initCode = _initCode(7);

        address expected = vm.computeCreate2Address(salt, keccak256(initCode), address(factory));
        address actual = factory.deploy(salt, initCode);

        assertEq(actual, expected, unicode"与 forge 官方公式不一致");
    }

    // ── 反事实地址（ERC-4337 前置概念）：initCode 决定未来账户地址 ──────────
    function test_counterfactualAddressBeforeDeploy() public {
        bytes32 salt = keccak256("p08/counterfactual-account");
        bytes memory initCode = _initCode(4337);

        // 部署前就能算出地址，且可以先「充值」——地址不依赖部署时序
        address future = factory.computeAddress(salt, keccak256(initCode));
        vm.deal(future, 1 ether);
        assertEq(future.balance, 1 ether, unicode"部署前预存余额应已到账");

        address actual = factory.deploy(salt, initCode);
        assertEq(actual, future, unicode"部署后地址应与反事实地址一致");
        assertEq(actual.balance, 1 ether, unicode"部署后余额应继承");
        assertEq(Beacon(actual).tag(), 4337, unicode"部署后代码可正常调用");
    }
}
