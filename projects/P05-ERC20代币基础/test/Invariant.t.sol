// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabToken} from "../src/LabToken.sol";

/// 不变式：供应量守恒 + 上限不破。handler 只通过合法入口操作，
/// 任何一条不变式被打破都意味着 _update 钩子或角色门禁有洞。
contract TokenHandler is Test {
    LabToken public token;
    address[] public actors;
    uint256 public sumMinted;
    uint256 public sumBurned;

    constructor(LabToken t) {
        token = t;
        actors = [makeAddr("h0"), makeAddr("h1"), makeAddr("h2")];
    }

    function actor(uint256 i) public view returns (address) {
        return actors[i % actors.length];
    }

    function mint(uint256 ai, uint256 amount) external {
        amount = bound(amount, 0, 1000e18);
        token.mint(actor(ai), amount);
        sumMinted += amount;
    }

    function burn(uint256 ai, uint256 amount) external {
        address a = actor(ai);
        amount = bound(amount, 0, token.balanceOf(a));
        vm.prank(a);
        token.burn(amount);
        sumBurned += amount;
    }

    function transfer(uint256 ai, uint256 bi, uint256 amount) external {
        address a = actor(ai);
        amount = bound(amount, 0, token.balanceOf(a));
        vm.prank(a);
        token.transfer(actor(bi), amount);
    }

    function approveAndPull(uint256 ai, uint256 bi, uint256 amount) external {
        address a = actor(ai);
        address b = actor(bi);
        amount = bound(amount, 0, token.balanceOf(a));
        vm.prank(a);
        token.approve(b, amount);
        vm.prank(b);
        token.transferFrom(a, b, amount);
    }
}

contract InvariantTest is Test {
    LabToken token;
    TokenHandler handler;
    uint256 constant CAP = 1_000_000e18;

    function setUp() public {
        token = new LabToken(address(this), CAP);
        handler = new TokenHandler(token);
        token.grantRole(token.MINTER_ROLE(), address(handler));
        targetContract(address(handler));
    }

    function invariant_SupplyEqualsSumOfBalances() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += token.balanceOf(handler.actor(i));
        }
        assertEq(sum, token.totalSupply());
    }

    function invariant_SupplyAccounting() public view {
        assertEq(handler.sumMinted() - handler.sumBurned(), token.totalSupply());
    }

    function invariant_CapNeverBroken() public view {
        assertLe(token.totalSupply(), CAP);
    }
}
