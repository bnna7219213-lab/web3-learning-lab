// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ILabIDView {
    function idOf(address) external view returns (uint256);
    function tierOf(address) external view returns (uint8);
}

interface ILabIDWrite {
    function addReputation(address, int256) external;
}

/**
 * @title SignalRegistry
 * @notice 身份信号哈希注册表——把「行为 / 生理 / 跨平台 / Agent 指纹」信号
 *         哈希上链作为可验证凭证，阈值确认后换算声誉分写入 LabID。
 *         对照精读：nexalink `contracts/cphs/CPHSRegistry.sol`（CPHS 信号层），机制同构。
 *
 * 三段流程：
 *  1. 数据提供方（Agent 运行时 / 游戏客户端 / 传感器）提交信号承诺：
 *     commit(subject, domain, sigHash, kind, ts)——原始信号向量留链下，只上链哈希。
 *  2. 验证者节点 EIP-191 签名确认，默认 3/5 阈值，达标自动入账。
 *  3. 写入 LabID.reputation → tier 提升；跨入 T1+ 发 ResonanceUnlocked 钩子事件。
 *
 * 防女巫与防重放：
 *  - 无 LabID 不能提交信号（匿名地址无法刷声誉）
 *  - 去重键 keccak(subject, domain, sigHash)，同一信号只能提交一次
 *  - 新鲜度窗口 24h + 时钟容差 1h（旧信号不能重放，未来信号拒绝）
 *  - 同一验证者对同一承诺只能签一次
 */
contract SignalRegistry is AccessControl, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice 可提交信号承诺的数据提供方。
    bytes32 public constant PROVIDER_ROLE = keccak256("PROVIDER_ROLE");
    /// @notice 验证者管理员（增删验证者、调阈值）。
    bytes32 public constant VERIFIER_ADMIN_ROLE = keccak256("VERIFIER_ADMIN_ROLE");

    enum SignalKind {
        Behavioral, // 0: 操作行为信号（支付行为习惯等）
        Physiological, // 1: 生物/生理信号（碳基主体）
        CrossPlatform, // 2: 跨平台身份一致性信号
        AgentFingerprint // 3: AI 智能体指纹（模型/运行时行为签名，硅基主体）
    }

    struct Commitment {
        address subject; // 被认定主体（须持 LabID）
        bytes32 sigHash; // 信号向量哈希（原文链下保存）
        SignalKind kind;
        uint64 ts; // 信号采集时间戳（链下时钟）
        uint64 committedAt; // 上链时间
        uint32 verifierCount; // 已确认验证者数
        uint256 weight; // 该信号换算的声誉分
        bool confirmed; // 是否已达阈值
    }

    address public immutable labId;
    mapping(address => bool) public isVerifier;
    address[] public verifierList;
    uint256 public confirmThreshold = 3;

    /// @notice 信号类型 → 声誉分权重（可治理调整）。
    mapping(uint8 => uint256) public kindWeight;

    uint256 public commitmentCount;
    mapping(uint256 => Commitment) private _commitments;
    /// @notice 去重键 (subject, domain, sigHash) → commitmentId（0 = 未提交）。
    mapping(bytes32 => uint256) public commitKeyToId;
    mapping(uint256 => mapping(address => bool)) private _hasSigned;
    mapping(uint256 => address[]) private _signersOf;

    uint256 public constant FRESHNESS = 24 hours;
    uint256 public constant CLOCK_TOLERANCE = 1 hours;

    event Committed(
        uint256 indexed commitmentId, address indexed subject, bytes32 sigHash, SignalKind kind, uint64 ts
    );
    event SignalConfirmed(
        uint256 indexed commitmentId, address indexed subject, uint256 weight, uint32 verifierCount
    );
    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event ThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    /// @notice 共鸣钩子：跨入 T1+ 时发出，供上层应用（GameFi / 权益解锁）监听。
    event ResonanceUnlocked(uint256 indexed commitmentId, address indexed subject, uint8 newTier);

    error NotVerifier(address signer);
    error NoLabID(address subject);
    error DuplicateCommit(bytes32 commitKey);
    error StaleSignal(uint64 ts, uint256 freshness);
    error FutureSignal(uint64 ts);
    error UnknownCommitment(uint256 commitmentId);
    error AlreadySigned(uint256 commitmentId, address verifier);
    error AlreadyConfirmed(uint256 commitmentId);
    error VerifierAlreadyAdded(address verifier);
    error BadThreshold();
    error BadSignalKind(uint8 kind);
    error WeightTooLarge(uint256 weight);
    error ZeroAddress();
    error ZeroSigHash();

    constructor(address admin, address labId_) {
        if (admin == address(0) || labId_ == address(0)) revert ZeroAddress();
        labId = labId_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PROVIDER_ROLE, admin);
        _grantRole(VERIFIER_ADMIN_ROLE, admin);
        kindWeight[uint8(SignalKind.Behavioral)] = 10;
        kindWeight[uint8(SignalKind.Physiological)] = 30;
        kindWeight[uint8(SignalKind.CrossPlatform)] = 40;
        kindWeight[uint8(SignalKind.AgentFingerprint)] = 20;
    }

    // ============ 1. 数据提供方：信号承诺 ============

    /**
     * @notice 提交信号承诺（仅 PROVIDER）。
     * @param domain  信号域标识（如 "agent:runtime"、"game:lab"）
     * @param sigHash keccak256(信号向量 + subject + 盐)——原文不上链
     * @param kind    信号类型（0-3）
     * @param ts      信号采集时间戳（链下时钟）
     */
    function commit(address subject, string calldata domain, bytes32 sigHash, uint8 kind, uint64 ts)
        external
        onlyRole(PROVIDER_ROLE)
        returns (uint256 commitmentId)
    {
        if (ILabIDView(labId).idOf(subject) == 0) revert NoLabID(subject);
        if (sigHash == bytes32(0)) revert ZeroSigHash();
        if (kind > uint8(SignalKind.AgentFingerprint)) revert BadSignalKind(kind);

        bytes32 commitKey = keccak256(abi.encodePacked(subject, domain, sigHash));
        if (commitKeyToId[commitKey] != 0) revert DuplicateCommit(commitKey);

        if (ts > block.timestamp + CLOCK_TOLERANCE) revert FutureSignal(ts);
        if (ts + FRESHNESS < block.timestamp) revert StaleSignal(ts, FRESHNESS);

        commitmentId = ++commitmentCount;
        _commitments[commitmentId] = Commitment({
            subject: subject,
            sigHash: sigHash,
            kind: SignalKind(kind),
            ts: ts,
            committedAt: uint64(block.timestamp),
            verifierCount: 0,
            weight: kindWeight[kind],
            confirmed: false
        });
        commitKeyToId[commitKey] = commitmentId;
        emit Committed(commitmentId, subject, sigHash, SignalKind(kind), ts);
    }

    // ============ 2. 验证者阈值确认 ============

    /**
     * @notice 验证者对信号承诺签名确认（EIP-191），达到阈值自动入账声誉。
     *         digest = toEthSignedMessageHash(keccak256(abi.encodePacked(
     *           "LabSignal-Confirm", commitmentId, subject, sigHash, kind, ts)))
     */
    function confirm(uint256 commitmentId, bytes calldata sig) external nonReentrant {
        Commitment storage c = _commitments[commitmentId];
        if (c.subject == address(0)) revert UnknownCommitment(commitmentId);
        if (c.confirmed) revert AlreadyConfirmed(commitmentId);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encodePacked("LabSignal-Confirm", commitmentId, c.subject, c.sigHash, uint8(c.kind), c.ts))
        );
        address signer = digest.recover(sig);
        if (!isVerifier[signer]) revert NotVerifier(signer);
        if (_hasSigned[commitmentId][signer]) revert AlreadySigned(commitmentId, signer);
        _hasSigned[commitmentId][signer] = true;
        _signersOf[commitmentId].push(signer);
        c.verifierCount += 1;

        if (c.verifierCount >= confirmThreshold) {
            c.confirmed = true;
            uint256 weight = c.weight;

            // 3. 写入 LabID reputation（tier 变化在 LabID 内部发事件）
            // casting to 'int256' is safe because kindWeight 被 setKindWeight 钳制在 int256.max 内
            // forge-lint: disable-next-line(unsafe-typecast)
            ILabIDWrite(labId).addReputation(c.subject, int256(weight));

            uint8 newTier = ILabIDView(labId).tierOf(c.subject);
            emit SignalConfirmed(commitmentId, c.subject, weight, c.verifierCount);
            if (newTier > 0) {
                emit ResonanceUnlocked(commitmentId, c.subject, newTier);
            }
        }
    }

    // ============ 验证者管理 ============

    function addVerifier(address v) external onlyRole(VERIFIER_ADMIN_ROLE) {
        if (v == address(0)) revert ZeroAddress();
        if (isVerifier[v]) revert VerifierAlreadyAdded(v);
        isVerifier[v] = true;
        verifierList.push(v);
        emit VerifierAdded(v);
    }

    function removeVerifier(address v) external onlyRole(VERIFIER_ADMIN_ROLE) {
        if (!isVerifier[v]) revert NotVerifier(v);
        isVerifier[v] = false;
        emit VerifierRemoved(v);
    }

    function setThreshold(uint256 t) external onlyRole(VERIFIER_ADMIN_ROLE) {
        if (t == 0 || t > verifierList.length) revert BadThreshold();
        emit ThresholdChanged(confirmThreshold, t);
        confirmThreshold = t;
    }

    function setKindWeight(uint8 kind, uint256 weight) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (kind > uint8(SignalKind.AgentFingerprint)) revert BadSignalKind(kind);
        if (weight > uint256(type(int256).max)) revert WeightTooLarge(weight);
        kindWeight[kind] = weight;
    }

    // ============ 视图 ============

    function verifierCount() external view returns (uint256) {
        return verifierList.length;
    }

    function signersOf(uint256 commitmentId) external view returns (address[] memory) {
        return _signersOf[commitmentId];
    }

    function commitmentOf(uint256 commitmentId) external view returns (Commitment memory) {
        if (_commitments[commitmentId].subject == address(0)) revert UnknownCommitment(commitmentId);
        return _commitments[commitmentId];
    }
}
