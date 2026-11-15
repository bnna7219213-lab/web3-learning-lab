// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILabIDTier {
    function tierOf(address) external view returns (uint8);
    function idOf(address) external view returns (uint256);
}

/**
 * @title PaymentAgent
 * @notice Agent 受限代付——用户预先授权「什么情况下可付」，之后 Agent 在边界内
 *         免用户操作执行；超出任何一条边界必须回到用户签名（硬边界，不可省）。
 *         对照精读：nexalink `contracts/cphs/PaymentAgent.sol`，机制同构 + 两处加固（见 docs/02）。
 *
 * 核心安全模型（双闸门，缺一不可）：
 *   单笔上限 = min(mandate.perTxLimit, tierPerTxLimit[payer.tier])
 *   累计上限 = min(mandate.totalLimit, tierTotalLimit[payer.tier])
 *   ——只有钱没有身份，或只有身份没有授权，都付不出。
 *
 * tier → 支付能力（渐变，非二元开关；LabUSD 6 位小数）：
 *   T0 无身份 → 0（不能代付）｜ T1 → 100/300 ｜ T2 → 1,000/3,000 ｜ T3 → 10,000/30,000
 *
 * PaymentMandate 四道锁：限额（单笔+累计）/ 限对象（收款方锚定）/ 限时（validUntil）/
 * 一次性登记（mandateHash 去重）。执行时点二次校验 tier：身份降级 → 额度即时收紧。
 *
 * 条件语义（「什么情况下」）：mandate.conditionHash 锚定触发条件的语义哈希，
 * 链上不解释条件本身——判定是 Agent 运行时的职责；链上保证每笔执行绑定它声称
 * 满足的条件哈希 + reasonRef 指向链下决策日志（不可事后改口，损失有界）。
 */
contract PaymentAgent is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Agent 运行时（代付执行方）。
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    IERC20 public immutable token;
    ILabIDTier public immutable labId;

    struct Mandate {
        address payer; // 授权人（须持 LabID）
        address payee; // 收款方（白名单锚点，创建后不可改）
        uint256 perTxLimit; // 单笔上限（已被 tier 钳制）
        uint256 totalLimit; // 累计上限（已被 tier 钳制）
        uint64 validUntil; // 过期时间
        bytes32 conditionHash; // 触发条件哈希（链下语义，链上锚定）
        uint256 spent; // 已执行累计
        bool active;
    }

    /// @notice tier → (单笔上限, 累计上限)，索引即 tier（0-3）。
    mapping(uint8 => uint256) public tierPerTxLimit;
    mapping(uint8 => uint256) public tierTotalLimit;

    uint256 public mandateCount;
    mapping(uint256 => Mandate) private _mandates;
    /// @notice 有效边界哈希 → mandateId（防同一授权重复登记）。
    mapping(bytes32 => uint256) public mandateHashToId;

    event MandateCreated(
        uint256 indexed mandateId,
        address indexed payer,
        address payee,
        uint256 perTxLimit,
        uint256 totalLimit,
        uint64 validUntil,
        bytes32 conditionHash
    );
    event MandateRevoked(uint256 indexed mandateId, address indexed payer);
    event AgentPaymentExecuted(
        uint256 indexed mandateId,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        bytes32 conditionHash,
        string reasonRef, // Agent 决策依据引用（链下审计日志 ID）
        uint64 executedAt
    );

    error ZeroAddress();
    error NoLabID(address payer);
    error TierTooLow(uint8 tier);
    error MandateNotFound(uint256 mandateId);
    error MandateInactive(uint256 mandateId);
    error MandateExpired(uint256 mandateId);
    error ExceedsPerTxLimit(uint256 amount, uint256 limit);
    error ExceedsTotalLimit(uint256 wouldSpend, uint256 limit);
    error ExceedsTierLimit(uint256 amount, uint256 tierCap);
    error DuplicateMandate(bytes32 mandateHash);
    error BadMandateParams();
    error UnauthorizedPayer(address caller);
    error UnauthorizedRevoker(address caller);

    constructor(address admin, address token_, address labId_) {
        if (admin == address(0) || token_ == address(0) || labId_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        labId = ILabIDTier(labId_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AGENT_ROLE, admin);

        tierPerTxLimit[0] = 0; // T0：不能代付
        tierPerTxLimit[1] = 100 * 1e6; // T1：单笔 100
        tierPerTxLimit[2] = 1_000 * 1e6; // T2：单笔 1,000
        tierPerTxLimit[3] = 10_000 * 1e6; // T3：单笔 10,000
        tierTotalLimit[0] = 0;
        tierTotalLimit[1] = 300 * 1e6; // T1：累计 300
        tierTotalLimit[2] = 3_000 * 1e6; // T2：累计 3,000
        tierTotalLimit[3] = 30_000 * 1e6; // T3：累计 30,000
    }

    // ============ 授权凭证管理 ============

    /**
     * @notice 创建支付授权（payer 须持 LabID——实名是代付的前提）。
     *         申请上限被钳制到 tier 上限：授权不能超越身份等级。
     */
    function createMandate(
        address payer,
        address payee,
        uint256 perTxLimit,
        uint256 totalLimit,
        uint64 validUntil,
        bytes32 conditionHash
    ) external returns (uint256 mandateId) {
        if (payer == address(0) || payee == address(0)) revert ZeroAddress();
        if (labId.idOf(payer) == 0) revert NoLabID(payer);
        if (perTxLimit == 0 || totalLimit < perTxLimit) revert BadMandateParams();
        if (validUntil <= block.timestamp) revert BadMandateParams();

        uint8 tier = labId.tierOf(payer);
        uint256 tierPerTx = tierPerTxLimit[tier];
        uint256 tierTotal = tierTotalLimit[tier];
        if (tierPerTx == 0) revert TierTooLow(tier);
        if (perTxLimit > tierPerTx) perTxLimit = tierPerTx;
        if (totalLimit > tierTotal) totalLimit = tierTotal;

        bytes32 mandateHash =
            keccak256(abi.encodePacked(payer, payee, perTxLimit, totalLimit, validUntil, conditionHash));
        if (mandateHashToId[mandateHash] != 0) revert DuplicateMandate(mandateHash);

        mandateId = ++mandateCount;
        _mandates[mandateId] = Mandate({
            payer: payer,
            payee: payee,
            perTxLimit: perTxLimit,
            totalLimit: totalLimit,
            validUntil: validUntil,
            conditionHash: conditionHash,
            spent: 0,
            active: true
        });
        mandateHashToId[mandateHash] = mandateId;
        emit MandateCreated(mandateId, payer, payee, perTxLimit, totalLimit, validUntil, conditionHash);
    }

    /// @notice 撤销授权（仅 payer 本人或治理），即时生效。
    function revokeMandate(uint256 mandateId) external {
        Mandate storage m = _mandates[mandateId];
        if (m.payer == address(0)) revert MandateNotFound(mandateId);
        if (msg.sender != m.payer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert UnauthorizedRevoker(msg.sender);
        }
        m.active = false;
        emit MandateRevoked(mandateId, m.payer);
    }

    // ============ Agent 代付执行 ============

    /**
     * @notice Agent 在 mandate 边界内代付（免用户操作的核心路径）。
     *         需 payer 预先 token.approve(本合约, ≥ totalLimit)。
     * @param reasonRef Agent 决策依据引用（链下审计日志，如 "agent_run:2026-0001"）
     */
    function pay(uint256 mandateId, uint256 amount, string calldata reasonRef) external nonReentrant {
        Mandate storage m = _mandates[mandateId];
        if (m.payer == address(0)) revert MandateNotFound(mandateId);

        // 调用者两类：① AGENT_ROLE（平台 Agent 运行时）② payer 本人（账户自调用）
        if (msg.sender != m.payer && !hasRole(AGENT_ROLE, msg.sender)) {
            revert UnauthorizedPayer(msg.sender);
        }

        if (!m.active) revert MandateInactive(mandateId);
        if (block.timestamp > m.validUntil) revert MandateExpired(mandateId);
        if (amount == 0 || amount > m.perTxLimit) revert ExceedsPerTxLimit(amount, m.perTxLimit);
        if (m.spent + amount > m.totalLimit) revert ExceedsTotalLimit(m.spent + amount, m.totalLimit);

        // 执行时点二次校验 tier（声誉是动态的：身份降级 → 单笔与累计额度同时收紧）
        uint8 tier = labId.tierOf(m.payer);
        if (amount > tierPerTxLimit[tier]) revert ExceedsTierLimit(amount, tierPerTxLimit[tier]);
        if (m.spent + amount > tierTotalLimit[tier]) revert ExceedsTierLimit(m.spent + amount, tierTotalLimit[tier]);

        m.spent += amount;
        token.safeTransferFrom(m.payer, m.payee, amount);

        emit AgentPaymentExecuted(
            mandateId, m.payer, m.payee, amount, m.conditionHash, reasonRef, uint64(block.timestamp)
        );
    }

    // ============ 视图 ============

    function mandateOf(uint256 mandateId) external view returns (Mandate memory) {
        if (_mandates[mandateId].payer == address(0)) revert MandateNotFound(mandateId);
        return _mandates[mandateId];
    }

    /// @notice 剩余可用额度 = min(剩余 mandate, 剩余 tier 累计)。
    function remainingAllowance(uint256 mandateId) external view returns (uint256) {
        Mandate storage m = _mandates[mandateId];
        if (m.payer == address(0)) return 0;
        uint256 mandateRemaining = m.totalLimit - m.spent;
        uint8 tier = labId.tierOf(m.payer);
        uint256 tierRemaining = tierTotalLimit[tier] > m.spent ? tierTotalLimit[tier] - m.spent : 0;
        return mandateRemaining < tierRemaining ? mandateRemaining : tierRemaining;
    }

    // ============ 治理（tier 上限可调） ============

    function setTierLimits(uint8 tier, uint256 perTx, uint256 total) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tier > 3 || total < perTx) revert BadMandateParams();
        tierPerTxLimit[tier] = perTx;
        tierTotalLimit[tier] = total;
    }
}
