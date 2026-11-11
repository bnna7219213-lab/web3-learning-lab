// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabToken} from "../src/LabToken.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// approve 竞态：改授权不是原子意图，mempool 里的旧授权可以被抢跑叠加。
/// 这里复现事故，并验证**真正有效**的缓解（确认后再授新 / permit 从零授权），
/// 同时钉死一个常见误解：OZ v4 的 decreaseAllowance 并不消除竞态（v5 已移除）。
contract ApproveRaceTest is Test {
    LabToken token;
    address owner = makeAddr("owner");
    address spender = makeAddr("spender");
    uint256 constant CAP = 1_000_000e18;

    function setUp() public {
        token = new LabToken(address(this), CAP);
        token.mint(owner, 1000e18);
    }

    function test_Race_DirectChangeLetsSpenderStackOldAndNew() public {
        vm.prank(owner);
        token.approve(spender, 100e18);

        // owner 想把授权降到 50；spender 在 mempool 看到两笔，抢先用旧授权
        vm.prank(spender);
        token.transferFrom(owner, spender, 100e18);
        vm.prank(owner);
        token.approve(spender, 50e18); // 降价交易现在才落块
        vm.prank(spender);
        token.transferFrom(owner, spender, 50e18);

        // 意图上限 50（原始授权 100），实际被提走 150
        assertEq(token.balanceOf(spender), 150e18);
    }

    function test_Mitigation_RevokeConfirmedThenGrant() public {
        vm.prank(owner);
        token.approve(spender, 100e18);

        // 第一步：撤销并**等确认**（测试里 tx 即确认；链上即等 receipt）
        vm.prank(owner);
        token.approve(spender, 0);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, 0, 100e18));
        token.transferFrom(owner, spender, 100e18); // 旧授权已死，抢跑无门

        // 第二步：授新额
        vm.prank(owner);
        token.approve(spender, 50e18);
        vm.prank(spender);
        token.transferFrom(owner, spender, 50e18);
        assertEq(token.balanceOf(spender), 50e18); // 恰好新意图，无叠加
    }

    function test_Mitigation_PermitFromZeroIsExactAndSingleUse() public {
        // 从零授权 + permit：owner 不发交易，签名即精确意图，nonce 保证单次
        uint256 ownerPk = 0xA11CE;
        address signer = vm.addr(ownerPk);
        token.mint(signer, 1000e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer,
                spender,
                50e18,
                0,
                deadline
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        vm.prank(spender); // spender 自己当 relayer 提交
        token.permit(signer, spender, 50e18, deadline, v, r, s);
        vm.prank(spender);
        token.transferFrom(signer, spender, 50e18);
        assertEq(token.balanceOf(spender), 50e18);

        // 重放同一签名 → 拒
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector);
        token.permit(signer, spender, 50e18, deadline, v, r, s);
    }

    function test_DecreaseAllowanceDoesNotFixRace() public {
        // OZ v4 的 decreaseAllowance(50) 语义 = approve(100-50)，竞态窗口原样存在。
        // 用裸 approve 模拟其语义，证明「delta 写法」不是缓解——这正是 v5 移除它的原因。
        vm.prank(owner);
        token.approve(spender, 100e18);
        vm.prank(spender);
        token.transferFrom(owner, spender, 100e18); // 抢跑旧授权
        vm.prank(owner);
        token.approve(spender, 100e18 - 50e18); // = decreaseAllowance(50)
        vm.prank(spender);
        token.transferFrom(owner, spender, 50e18);
        assertEq(token.balanceOf(spender), 150e18); // 依旧叠加
    }
}
