// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Smoke} from "../src/Smoke.sol";

/// @notice P8-S1 脚手架冒烟测试
contract SmokeTest is Test {
    Smoke internal smoke;

    function setUp() public {
        smoke = new Smoke();
    }

    function test_ping() public view {
        assertEq(smoke.ping(), "p08-ok");
    }

    function test_set() public {
        smoke.set(42);
        assertEq(smoke.value(), 42);
    }
}
