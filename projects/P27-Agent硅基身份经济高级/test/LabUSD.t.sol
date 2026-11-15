// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {LabUSD} from "../src/LabUSD.sol";

/// 记账单位：6 位小数（对齐 tier 上限表精度）/ 铸造权限。
contract LabUSDTest is Test {
    LabUSD internal usd;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    function setUp() public {
        usd = new LabUSD(admin);
    }

    function test_MetadataAndDecimals() public {
        assertEq(usd.decimals(), 6);
        assertEq(usd.name(), "Lab USD (learning unit)");
        assertEq(usd.symbol(), "LabUSD");
        assertEq(usd.totalSupply(), 0);
    }

    function test_Mint_OnlyMinter() public {
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        vm.prank(alice);
        usd.mint(alice, 1e6);
        vm.prank(admin);
        usd.mint(alice, 100e6);
        assertEq(usd.balanceOf(alice), 100e6);
        assertEq(usd.totalSupply(), 100e6);
    }

    function test_Constructor_ZeroAdminRejected() public {
        vm.expectRevert(LabUSD.ZeroAddress.selector);
        new LabUSD(address(0));
    }
}
