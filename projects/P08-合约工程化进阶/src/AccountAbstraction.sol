// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title MinimalUserOperation —— ERC-4337 UserOperation 的概念裁剪版（P8-S6）
/// @notice 真实 4337 的 UserOperation 有 10+ 字段（gas 构成 / paymaster / stake…），
///         这里只保留理解账户抽象「三件事」所必需的：
///         sender（反事实地址）· nonce（重放保护）· initCode（首部署）· signature（验证入口在账户内）
/// @dev 签名编码约定：
///         root == 0 时：signature = 65 字节 ECDSA
///         root != 0 时：signature = 65 字节 ECDSA ++ abi.encode(bytes32[] whitelistProof)（双因素）
struct MinimalUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes signature;
}

/// @title SmartAccount —— 智能账户：验签规则写进合约，而非 EOA 私钥
/// @notice 与 EOA 的本质差异 = **验证逻辑可编程**。演示两条规则：
///         1. 单签：owner ECDSA（EOA 语义基线）
///         2. 双因素：owner ECDSA + Merkle 白名单成员证明（复用 S5 的批次白名单思路）
contract SmartAccount {
    using ECDSA for bytes32;

    address public immutable owner;
    bytes32 public immutable root; // 双因素白名单树根；0 → 关闭该规则
    address public immutable entryPoint;

    uint256 public nonce;
    uint256 public depositAmount;

    event Executed(uint256 indexed nonce, bytes4 selector);

    error NotFromEntryPoint();
    error NonceMismatch(uint256 expected, uint256 got);

    constructor(address owner_, bytes32 root_, address entryPoint_) {
        owner = owner_;
        root = root_;
        entryPoint = entryPoint_;
    }

    /// @notice 概念核1：签名验证入口在账户内（validateUserOp 的等价物）
    /// @dev 消息域 = keccak(userOpHash ++ block.chainid)：
    ///      chainid 进哈希 = 跨链重放保护（与 P05 permit 的域分隔同一手法）；
    ///      userOpHash 覆盖 sender/nonce/callData，绑定「谁、第几笔、做什么」。
    function validateOp(MinimalUserOperation calldata op, bytes32 userOpHash) external view returns (bool) {
        if (op.sender != address(this)) return false;
        if (op.nonce != nonce) return false;

        bytes32 digest = keccak256(abi.encodePacked(userOpHash, block.chainid));
        (bytes calldata ecdsaSig, bytes calldata proofBlob) = _splitSig(op.signature);

        if (digest.recover(ecdsaSig) != owner) return false;

        if (root == bytes32(0)) return true; // 单签规则到此通过

        // 双因素规则：白名单成员证明必须能对上 root（成员 = entryPoint 标识，教学约定）
        if (proofBlob.length == 0) return false;
        bytes32[] memory proof = abi.decode(proofBlob, (bytes32[]));
        bytes32 member = keccak256(abi.encodePacked("member|", entryPoint));
        return MerkleProof.verify(proof, root, member);
    }

    /// @notice 概念核2：由 EntryPoint 调用执行（handleOps 的落点），nonce 先+1 再做事
    /// @dev payable：EntryPoint 的入金随 Op 转给业务 callData（真实 4337 由账户余额/prefund 承担）
    function execute(MinimalUserOperation calldata op) external payable {
        if (msg.sender != entryPoint) revert NotFromEntryPoint();
        if (nonce != op.nonce) revert NonceMismatch(nonce, op.nonce);
        unchecked {
            ++nonce;
        }
        (bool ok,) = address(this).call{value: msg.value}(op.callData);
        require(ok, unicode"exec failed");
        emit Executed(op.nonce, bytes4(op.callData));
    }

    receive() external payable {
        depositAmount += msg.value;
    }

    /// @notice 业务入金入口（callData 目标；与 receive 等价，便于绑定进 userOpHash 演示）
    function deposit() external payable {
        depositAmount += msg.value;
    }

    function _splitSig(bytes calldata sig) internal pure returns (bytes calldata ecdsaSig, bytes calldata rest) {
        if (sig.length == 65) return (sig, sig[65:]); // 空尾段
        require(sig.length > 65, unicode"bad signature length");
        return (sig[:65], sig[65:]);
    }
}

/// @title MiniEntryPoint —— 概念版 bundler + EntryPoint 合体
/// @notice 只做三件事：反事实部署（CREATE2 语义见 S3）→ 验证 → 执行。
///         真实 4337 还有 AltMempool / paymaster 供养 / Stake 等，本项目不展开（README 边界）。
contract MiniEntryPoint {
    using ECDSA for bytes32;

    bytes32 internal constant SALT = keccak256("p08.smart-account.v1");

    event HandleOp(address indexed sender, uint256 nonce);

    function getUserOpHash(MinimalUserOperation calldata op) public view returns (bytes32) {
        return keccak256(abi.encode(op.sender, op.nonce, keccak256(op.callData), block.chainid));
    }

    /// @notice 反事实地址预计算：部署前就能算出账户地址（与 S3 同一公式）
    function computeSender(bytes memory initCode) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), SALT, keccak256(initCode)))))
        );
    }

    function handleOp(MinimalUserOperation calldata op) external payable {
        // 1) 反事实部署：账户没代码 → 用 initCode 按 CREATE2 落地；
        //    地址必须等于预计算的 sender（initCode 决定地址，S3 的结论在这里复用）
        if (op.sender.code.length == 0) {
            require(op.initCode.length > 0, unicode"no initCode and not deployed");
            bytes memory initCode = op.initCode;
            address predicted = this.computeSender(initCode);
            require(predicted == op.sender, unicode"initCode does not derive sender");
            bytes32 salt = SALT;
            assembly {
                if iszero(create2(0, add(initCode, 0x20), mload(initCode), salt)) {
                    revert(0, 0)
                }
            }
        } else {
            require(op.initCode.length == 0, unicode"initCode must be empty after deploy");
        }

        // 2) 验证：逻辑全在账户里（这就是「账户抽象」——EntryPoint 只是搬运工）
        bytes32 userOpHash = this.getUserOpHash(op);
        require(SmartAccount(payable(op.sender)).validateOp(op, userOpHash), unicode"validateOp failed");

        // 3) 执行（value 随 Op 传递给账户的业务 callData）
        SmartAccount(payable(op.sender)).execute{value: msg.value}(op);
        emit HandleOp(op.sender, op.nonce);
    }
}
