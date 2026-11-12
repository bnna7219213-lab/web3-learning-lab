// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {MinimalUserOperation, SmartAccount, MiniEntryPoint} from "../src/AccountAbstraction.sol";

/// @notice P8-S6：ERC-4337 概念落地——反事实地址 + 账户内验签 + nonce 重放保护
contract AccountAbstractionTest is Test {
    MiniEntryPoint internal ep;

    uint256 internal ownerKey = 0xA11CE;
    address internal owner;
    address internal mallory = makeAddr("mallory");

    bytes32 internal constant ROOT_OFF = bytes32(0); // 单签模式

    function setUp() public {
        owner = vm.addr(ownerKey);
        ep = new MiniEntryPoint();
    }

    function _initCode(address owner_, bytes32 root_, address epAddr) internal pure returns (bytes memory) {
        return abi.encodePacked(type(SmartAccount).creationCode, abi.encode(owner_, root_, epAddr));
    }

    /// @dev 组装 + 签名一笔 UserOp（digest = keccak(userOpHash ++ chainid)，与 validateOp 同构）
    function _signedOp(address sender, uint256 nonce, bytes memory initCode, bytes memory callData, uint256 key)
        internal
        view
        returns (MinimalUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = nonce;
        op.initCode = initCode;
        op.callData = callData;
        bytes32 userOpHash = ep.getUserOpHash(
            MinimalUserOperation({
                sender: sender, nonce: nonce, initCode: initCode, callData: callData, signature: ""
            })
        );
        bytes32 digest = keccak256(abi.encodePacked(userOpHash, block.chainid));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.signature = abi.encodePacked(r, s, v); // 65 字节：r(32) ++ s(32) ++ v(1)
    }

    /// @dev 同上但直接返回 65 字节签名（双因素/负例复用）
    function _sign65(uint256 key, bytes32 userOpHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(userOpHash, block.chainid));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── 概念核1：反事实地址——部署前先算地址并充值，首笔 Op 带 initCode 落地 ──
    function test_counterfactualDeployAndDeposit() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);

        // 部署前：账户不存在但地址可预计算，并可先充值（S3 的结论在 AA 里复用）
        assertTrue(sender.code.length == 0, unicode"部署前应无代码");
        vm.deal(sender, 1 ether);

        // 首笔 Op：入金 0.5 ether（value 随 Op 经 EntryPoint 转给账户的 deposit()）
        bytes memory callData = abi.encodeWithSignature("deposit()");
        MinimalUserOperation memory op = _signedOp(sender, 0, initCode, callData, ownerKey);

        ep.handleOp{value: 0.5 ether}(op);

        assertTrue(sender.code.length > 0, unicode"首笔 Op 后账户应已部署");
        assertEq(SmartAccount(payable(sender)).depositAmount(), 0.5 ether, unicode"入金应到账");
        assertEq(SmartAccount(payable(sender)).nonce(), 1, unicode"执行后 nonce 应为 1");
        assertEq(SmartAccount(payable(sender)).owner(), owner, unicode"owner 应为签名人");
        assertEq(sender.balance, 1.5 ether, unicode"预存 1 + 本次 0.5 应全在账户");
    }

    // ── 概念核2：nonce 重放——同一笔 Op 第二次必须被拒 ────────────────────────
    function test_replayRejectedByNonce() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);
        bytes memory callData = abi.encodeWithSignature("deposit()");

        MinimalUserOperation memory op = _signedOp(sender, 0, initCode, callData, ownerKey);
        ep.handleOp(op);

        // 重放同一笔（initCode 已部署须置空——它不进 userOpHash，签名仍有效；
        // 但 nonce 仍是 0 而链上已是 1 → validateOp 的 nonce 校验失败）
        op.initCode = "";
        vm.expectRevert(bytes("validateOp failed"));
        ep.handleOp(op);
    }

    // ── 负例1：签名被拒（错误私钥）────────────────────────────────────────────
    function test_wrongSignerRejected() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);
        bytes memory callData = abi.encodeWithSignature("deposit()");

        uint256 malloryKey = 0xB0B;
        MinimalUserOperation memory op = _signedOp(sender, 0, initCode, callData, malloryKey);

        vm.expectRevert(bytes("validateOp failed"));
        ep.handleOp(op);
        assertTrue(sender.code.length == 0, unicode"被拒的 Op 不应留下部署副作用");
    }

    // ── 负例2：initCode 与 sender 不匹配 → 拒（地址由 initCode 决定，S3 结论）──
    function test_initCodeSenderMismatchRejected() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);
        bytes memory callData = abi.encodeWithSignature("deposit()");

        // 把 sender 换成别的地址（initCode 仍是原份）→ 地址推导不匹配
        MinimalUserOperation memory op = _signedOp(sender, 0, initCode, callData, ownerKey);
        op.sender = address(uint160(uint256(keccak256("bogus")) + 1));

        vm.expectRevert(bytes("initCode does not derive sender"));
        ep.handleOp(op);
    }

    // ── 负例3：callData 篡改 → userOpHash 变 → 签名失效 ──────────────────────
    function test_callDataTamperRejected() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);

        // 为 deposit() 签名，随后把 callData 换成别的函数（签名不重签）
        MinimalUserOperation memory tampered =
            _signedOp(sender, 0, initCode, abi.encodeWithSignature("deposit()"), ownerKey);
        tampered.callData = abi.encodeWithSignature("nonexistent()");

        vm.expectRevert(bytes("validateOp failed"));
        ep.handleOp(tampered);
    }

    // ── 概念核3：双因素模式——owner 签名 + Merkle 白名单证明 ─────────────────
    function test_twoFactorWithMerkleWhitelist() public {
        // 白名单成员 = keccak("member|" ++ entryPoint)（SmartAccount.validateOp 的约定）
        bytes32 member = keccak256(abi.encodePacked("member|", address(ep)));
        // 单成员树：root = member（OZ MerkleProof 对单元素证明返回 true 的等价约定：
        // 空 proof + root==leaf → verify 为 true——正好等价「白名单只有一人」）
        bytes32 root = member;

        bytes memory initCode = _initCode(owner, root, address(ep));
        address sender = ep.computeSender(initCode);
        bytes memory callData = abi.encodeWithSignature("deposit()");

        // 组 op：签名 = ECDSA(65) ++ abi.encode(proof[])
        bytes32 userOpHash = ep.getUserOpHash(
            MinimalUserOperation({sender: sender, nonce: 0, initCode: initCode, callData: callData, signature: ""})
        );
        bytes memory proof = abi.encode(new bytes32[](0)); // 空证明（单成员树）
        MinimalUserOperation memory op = MinimalUserOperation({
            sender: sender,
            nonce: 0,
            initCode: initCode,
            callData: callData,
            signature: abi.encodePacked(_sign65(ownerKey, userOpHash), proof)
        });

        ep.handleOp{value: 0.5 ether}(op);
        assertEq(SmartAccount(payable(sender)).depositAmount(), 0.5 ether, unicode"双因素通过并入金");

        // 负例：账户已部署（initCode 置空），有 owner 签名但不带白名单证明 → 拒
        bytes32 h2 = ep.getUserOpHash(
            MinimalUserOperation({sender: sender, nonce: 1, initCode: "", callData: callData, signature: ""})
        );
        MinimalUserOperation memory op2 = MinimalUserOperation({
            sender: sender, nonce: 1, initCode: "", callData: callData, signature: _sign65(ownerKey, h2)
        });
        vm.expectRevert(bytes("validateOp failed"));
        ep.handleOp(op2);
    }

    // ── 负例4：非 EntryPoint 调 execute → 拒（执行入口与验证入口同受控）───────
    function test_executeOnlyEntryPoint() public {
        bytes memory initCode = _initCode(owner, ROOT_OFF, address(ep));
        address sender = ep.computeSender(initCode);
        ep.handleOp(_signedOp(sender, 0, initCode, abi.encodeWithSignature("deposit()"), ownerKey));

        SmartAccount account = SmartAccount(payable(sender));
        vm.prank(mallory);
        vm.expectRevert(SmartAccount.NotFromEntryPoint.selector);
        account.execute(
            MinimalUserOperation({
                sender: sender, nonce: 1, initCode: "", callData: abi.encodeWithSignature("deposit()"), signature: ""
            })
        );
    }
}
