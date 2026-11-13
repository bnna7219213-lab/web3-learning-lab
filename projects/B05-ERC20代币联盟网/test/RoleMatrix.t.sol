// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabToken} from "../src/LabToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice B05 角色矩阵：谁能发行(mint)、谁能销毁(burnFrom)、谁能改角色(grant/revoke)。
///         联盟语义下「发行权」不是合约 owner 一个人的事，而是**角色治理**：
///         运营方(admin)、发行方(minter)、审计方(auditor)、成员(member)、外部(outsider) 五种身份，
///         每个格子要么放行、要么 revert 且 **revert 数据里带 (account, role)** —— 这就是负例的可审计痕迹
///         （链上层的完整留痕在验收脚本里以 status=0 回执形式落块）。
contract RoleMatrixTest is Test {
    LabToken token;
    address admin = makeAddr("admin"); // 运营方：DEFAULT_ADMIN + MINTER
    address minter = makeAddr("minter"); // 发行方：MINTER
    address auditor = makeAddr("auditor"); // 审计方：无操作权，只读核对
    address member = makeAddr("member"); // 成员：持币/转账/自毁
    address outsider = makeAddr("outsider"); // 外部：无任何权限
    uint256 constant CAP = 1_000e18;
    bytes32 minterRole;
    bytes32 adminRole;

    function setUp() public {
        token = new LabToken(admin, CAP);
        minterRole = token.MINTER_ROLE();
        adminRole = token.DEFAULT_ADMIN_ROLE();
        vm.startPrank(admin);
        token.grantRole(minterRole, minter);
        token.mint(member, 100e18);
        vm.stopPrank();
    }

    // ---------- 负例矩阵（≥6 条：未授权 mint/burn/改角色全部 revert） ----------

    /// 负例 1：成员（无 MINTER_ROLE）铸币
    function test_Neg_MintByMemberRevertsWithActor() public {
        vm.prank(member);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, member, minterRole));
        token.mint(member, 1e18);
    }

    /// 负例 2：外部账户铸币
    function test_Neg_MintByOutsiderRevertsWithActor() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, minterRole));
        token.mint(outsider, 1e18);
    }

    /// 负例 3：发行方越权给自己发 admin 权
    function test_Neg_GrantAdminByMinterReverts() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, minter, adminRole));
        token.grantRole(adminRole, minter);
    }

    /// 负例 4：成员越权把铸币权给自己
    function test_Neg_GrantMinterByMemberReverts() public {
        vm.prank(member);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, member, adminRole));
        token.grantRole(minterRole, member);
    }

    /// 负例 5：外部越权撤销发行方
    function test_Neg_RevokeByOutsiderReverts() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, adminRole));
        token.revokeRole(minterRole, minter);
    }

    /// 负例 6：发行方连自己的角色都撤不掉（改角色只认 DEFAULT_ADMIN）
    function test_Neg_RevokeSelfByMinterReverts() public {
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, minter, adminRole));
        token.revokeRole(minterRole, minter);
    }

    /// 负例 7：无授权代销毁他人持仓（burnFrom 必须有 allowance）
    function test_Neg_BurnFromWithoutAllowanceReverts() public {
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, outsider, 0, 1e18)
        );
        token.burnFrom(member, 1e18);
    }

    /// 负例 8：超过 CAP 的铸造被上限拦（谁能发之外还有「能发多少」）
    function test_Neg_MintOverCapReverts() public {
        // CapExceeded 的第二参数是 attempted = totalSupply + value（setUp 已铸 100e18）
        uint256 attempted = token.totalSupply() + CAP + 1;
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(LabToken.CapExceeded.selector, CAP, attempted));
        token.mint(member, CAP + 1);
    }

    // ---------- 正例（放行 + 事件留痕） ----------

    /// 授权留痕：grantRole 必须打 RoleGranted(role, account, sender)
    function test_Pos_GrantMinterEmitsRoleGranted() public {
        vm.expectEmit(true, true, true, true);
        emit IAccessControl.RoleGranted(minterRole, auditor, admin);
        vm.prank(admin);
        token.grantRole(minterRole, auditor);
        assertTrue(token.hasRole(minterRole, auditor));
    }

    /// 收回留痕：revokeRole 打 RoleRevoked，且**立即生效**（收回后再铸必 revert）
    function test_Pos_RevokeMinterEmitsRoleRevokedAndTakesEffect() public {
        vm.expectEmit(true, true, true, true);
        emit IAccessControl.RoleRevoked(minterRole, minter, admin);
        vm.prank(admin);
        token.revokeRole(minterRole, minter);

        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, minter, minterRole));
        token.mint(member, 1e18);
    }

    /// 铸币留痕：mint 打 Transfer(0x0 → to)
    function test_Pos_MintByMinterEmitsTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit IERC20.Transfer(address(0), auditor, 5e18);
        vm.prank(minter);
        token.mint(auditor, 5e18);
    }

    /// 成员自毁：burn 是持币人自己的权利，不需要角色（「谁能销毁」的另一半答案）
    function test_Pos_MemberBurnsOwn() public {
        vm.prank(member);
        token.burn(10e18);
        assertEq(token.balanceOf(member), 90e18);
    }

    /// 角色快照：五种身份的权限格子一目了然（deployments/roles.json 的链上对照源）
    function test_Pos_RoleSnapshot() public view {
        assertTrue(token.hasRole(adminRole, admin));
        assertTrue(token.hasRole(minterRole, admin));
        assertTrue(token.hasRole(minterRole, minter));
        assertFalse(token.hasRole(minterRole, auditor));
        assertFalse(token.hasRole(minterRole, member));
        assertFalse(token.hasRole(minterRole, outsider));
        assertFalse(token.hasRole(adminRole, minter));
        assertFalse(token.hasRole(adminRole, auditor));
        assertFalse(token.hasRole(adminRole, member));
        assertFalse(token.hasRole(adminRole, outsider));
    }
}
