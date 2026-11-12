// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title P08 脚手架冒烟合约（S1）——确认工具链可用后由正式合约替换
contract Smoke {
    uint256 public value;

    function ping() external pure returns (string memory) {
        return "p08-ok";
    }

    function set(uint256 v) external {
        value = v;
    }
}
