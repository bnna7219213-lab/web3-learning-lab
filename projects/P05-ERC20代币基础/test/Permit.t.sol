// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabToken} from "../src/LabToken.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// permit 的安全含义：签名即授权，且**只能授权一次、只在这一条链、只在期限内**。
/// 验收门禁：改 chainId / 重放 nonce 必须失败。
contract PermitTest is Test {
    LabToken token;
    uint256 ownerPk = 0xA11CE;
    address owner;
    address spender = makeAddr("spender");
    address relayer = makeAddr("relayer");
    uint256 constant CAP = 1_000_000e18;

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        token = new LabToken(address(this), CAP);
        owner = vm.addr(ownerPk);
    }

    function _digest(
        address owner_,
        address spender_,
        uint256 value,
        uint256 nonce,
        uint256 deadline,
        uint256 chainId
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender_, value, nonce, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Learning Lab Token")),
                keccak256(bytes("1")),
                chainId,
                address(token)
            )
        );
        return MessageHashUtils.toTypedDataHash(domain, structHash);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(pk, digest);
    }

    function test_PermitSetsAllowanceWithoutOwnerTx() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);

        uint256 ownerNonceBefore = token.nonces(owner);
        vm.expectEmit(true, true, false, true);
        emit IERC20.Approval(owner, spender, 50e18);
        vm.prank(relayer); // owner 全程不发交易（gasless 授权）
        token.permit(owner, spender, 50e18, deadline, v, r, s);

        assertEq(token.allowance(owner, spender), 50e18);
        assertEq(token.nonces(owner), ownerNonceBefore + 1);
    }

    function test_PermitReplayFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);
        token.permit(owner, spender, 50e18, deadline, v, r, s);

        // 同一签名再来一次：nonce 已推进，恢复出的 signer 对不上 → 拒
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector); // 恢复出的 signer 不可预测：前缀匹配错误类型
        token.permit(owner, spender, 50e18, deadline, v, r, s);
    }

    function test_PermitWithStaleNonceFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        // 先用掉 nonce 0
        bytes32 d0 = _digest(owner, spender, 1e18, 0, deadline, block.chainid);
        (uint8 v0, bytes32 r0, bytes32 s0) = _sign(ownerPk, d0);
        token.permit(owner, spender, 1e18, deadline, v0, r0, s0);
        // 拿 nonce=0 的旧签名授权新金额 → 拒
        bytes32 d1 = _digest(owner, spender, 999e18, 0, deadline, block.chainid);
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(ownerPk, d1);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector); // 恢复出的 signer 不可预测：前缀匹配错误类型
        token.permit(owner, spender, 999e18, deadline, v1, r1, s1);
    }

    function test_DomainSeparatorTracksChainId() public {
        bytes32 before = token.DOMAIN_SEPARATOR();
        vm.chainId(999);
        bytes32 switched = token.DOMAIN_SEPARATOR();
        assertTrue(before != switched); // 链换了，域分隔必须换
    }

    function test_PermitSignedOnOtherChainFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        // 在 chainId=999 上签的授权，拿到本链用 → 拒（EIP-155 思想在 EIP-712 域的延伸）
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, 999);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector); // 恢复出的 signer 不可预测：前缀匹配错误类型
        token.permit(owner, spender, 50e18, deadline, v, r, s);
    }

    function test_PermitAfterChainSwitchFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);
        vm.chainId(999); // 签名后链切换（硬分叉/换网场景）
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector); // 恢复出的 signer 不可预测：前缀匹配错误类型
        token.permit(owner, spender, 50e18, deadline, v, r, s);
    }

    function test_PermitExpiredDeadlineFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline));
        token.permit(owner, spender, 50e18, deadline, v, r, s);
    }

    function test_PermitWrongSignerFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, digest); // 别人的私钥
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612InvalidSigner.selector, vm.addr(0xB0B), owner));
        token.permit(owner, spender, 50e18, deadline, v, r, s);
    }

    function test_PermitTamperedValueFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(owner, spender, 50e18, 0, deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerPk, digest);
        // 中继把金额改成 500 → 签名覆盖全字段，恢复失败
        vm.expectPartialRevert(ERC20Permit.ERC2612InvalidSigner.selector); // 恢复出的 signer 不可预测：前缀匹配错误类型
        token.permit(owner, spender, 500e18, deadline, v, r, s);
    }

    function testFuzz_PermitWithRandomKeys(uint256 pk, uint256 value, uint256 ttl) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        value = bound(value, 0, CAP);
        ttl = bound(ttl, 1, 365 days);
        address signer = vm.addr(pk);
        uint256 deadline = block.timestamp + ttl;
        bytes32 digest = _digest(signer, spender, value, token.nonces(signer), deadline, block.chainid);
        (uint8 v, bytes32 r, bytes32 s) = _sign(pk, digest);
        vm.prank(relayer);
        token.permit(signer, spender, value, deadline, v, r, s);
        assertEq(token.allowance(signer, spender), value);
        assertEq(token.nonces(signer), 1);
    }
}
