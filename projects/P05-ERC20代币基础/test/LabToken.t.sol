// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabToken} from "../src/LabToken.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract LabTokenTest is Test {
    LabToken token;
    address admin = makeAddr("admin");
    address minter = makeAddr("minter");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant CAP = 1_000_000e18;
    bytes32 minterRole;
    bytes32 adminRole;

    function setUp() public {
        token = new LabToken(admin, CAP);
        minterRole = token.MINTER_ROLE();
        adminRole = token.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        token.grantRole(minterRole, minter);
    }

    // ---------- 元数据与构造 ----------

    function test_Metadata() public view {
        assertEq(token.name(), "Learning Lab Token");
        assertEq(token.symbol(), "LAB");
        assertEq(token.decimals(), 18);
        assertEq(token.VERSION(), "1.0.0");
        assertEq(token.CAP(), CAP);
    }

    function test_AdminIsExternalized() public view {
        // P04 教训：owner 写死 msg.sender 会让部署账户永久掌权；这里 admin 是构造参数
        assertTrue(token.hasRole(adminRole, admin));
        assertFalse(token.hasRole(adminRole, address(this)));
        assertTrue(token.hasRole(minterRole, admin));
    }

    function test_ZeroAdminReverts() public {
        vm.expectRevert(LabToken.ZeroAdmin.selector);
        new LabToken(address(0), CAP);
    }

    function test_ZeroCapReverts() public {
        vm.expectRevert(LabToken.ZeroCap.selector);
        new LabToken(admin, 0);
    }

    // ---------- mint / cap ----------

    function test_MintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, false, true);
        emit IERC20.Transfer(address(0), alice, 100e18);
        vm.prank(minter);
        token.mint(alice, 100e18);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(token.totalSupply(), 100e18);
    }

    function test_MintRequiresMinterRole() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole)
        );
        token.mint(alice, 1);
    }

    function test_MintUpToCapThenRevert() public {
        vm.startPrank(minter);
        token.mint(alice, CAP);
        vm.expectRevert(abi.encodeWithSelector(LabToken.CapExceeded.selector, CAP, CAP + 1));
        token.mint(alice, 1);
        vm.stopPrank();
        assertEq(token.totalSupply(), CAP);
    }

    function testFuzz_MintNeverExceedsCap(uint256 a, uint256 b) public {
        a = bound(a, 0, CAP);
        b = bound(b, 0, CAP);
        vm.startPrank(minter);
        token.mint(alice, a);
        if (a + b > CAP) {
            vm.expectRevert(abi.encodeWithSelector(LabToken.CapExceeded.selector, CAP, a + b));
            token.mint(bob, b);
        } else {
            token.mint(bob, b);
        }
        vm.stopPrank();
        assertLe(token.totalSupply(), CAP);
    }

    // ---------- burn ----------

    function test_BurnOwnAndBurnFrom() public {
        vm.prank(minter);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.burn(40e18);
        assertEq(token.balanceOf(alice), 60e18);
        assertEq(token.totalSupply(), 60e18);

        vm.prank(alice);
        token.approve(bob, 30e18);
        vm.prank(bob);
        token.burnFrom(alice, 30e18);
        assertEq(token.balanceOf(alice), 30e18);
        assertEq(token.allowance(alice, bob), 0);
    }

    function test_BurnMoreThanBalanceReverts() public {
        vm.prank(minter);
        token.mint(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10e18, 11e18));
        token.burn(11e18);
    }

    // ---------- transfer / allowance ----------

    function test_TransferAndTransferFrom() public {
        vm.prank(minter);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.transfer(bob, 25e18);
        assertEq(token.balanceOf(bob), 25e18);

        vm.prank(alice);
        token.approve(bob, 50e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 50e18);
        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.balanceOf(alice), 25e18);
    }

    function test_InfiniteAllowanceNotDecremented() public {
        vm.prank(minter);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, bob, 10e18);
        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    function test_TransferToZeroReverts() public {
        vm.prank(minter);
        token.mint(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.transfer(address(0), 1);
    }

    function testFuzz_TransferConservesSupply(uint256 amount, uint256 send) public {
        amount = bound(amount, 1, CAP);
        send = bound(send, 0, amount);
        vm.prank(minter);
        token.mint(alice, amount);
        vm.prank(alice);
        token.transfer(bob, send);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), amount);
        assertEq(token.totalSupply(), amount);
    }

    // ---------- 角色治理 ----------

    function test_RoleGrantRevokeRenounce() public {
        vm.prank(admin);
        token.grantRole(minterRole, alice);
        vm.prank(alice);
        token.mint(alice, 1e18);

        vm.prank(admin);
        token.revokeRole(minterRole, alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole)
        );
        token.mint(alice, 1);

        vm.prank(alice);
        token.renounceRole(minterRole, alice); // 已无角色，renounce 自身是幂等 no-op
        assertFalse(token.hasRole(minterRole, alice));
    }

    function test_NonAdminCannotGrant() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, adminRole)
        );
        token.grantRole(minterRole, alice);
    }

    // ---------- 舍入方向 ----------

    function test_QuoteProRataRoundsDown() public {
        vm.startPrank(minter);
        token.mint(alice, 1e18);
        token.mint(bob, 2e18);
        vm.stopPrank();
        // pool=10 wei，alice 占 1/3 → 3.33… → 3（向下）；bob 6.66… → 6；dust 1 留池
        assertEq(token.quoteProRata(10, alice), 3);
        assertEq(token.quoteProRata(10, bob), 6);
        assertLe(token.quoteProRata(10, alice) + token.quoteProRata(10, bob), 10);
    }

    function test_QuoteProRataZeroSupply() public view {
        assertEq(token.quoteProRata(100, alice), 0);
    }

    function testFuzz_QuoteProRataNeverOverpays(uint256 pool, uint256 a, uint256 b) public {
        pool = bound(pool, 0, 1e30);
        a = bound(a, 1, CAP / 2);
        b = bound(b, 1, CAP / 2);
        vm.startPrank(minter);
        token.mint(alice, a);
        token.mint(bob, b);
        vm.stopPrank();
        uint256 qa = token.quoteProRata(pool, alice);
        uint256 qb = token.quoteProRata(pool, bob);
        assertLe(qa + qb, pool); // 向下取整 ⇒ 分出去的永远不超过池子
        assertLe(qa, pool * a / (a + b) + 1);
    }
}
