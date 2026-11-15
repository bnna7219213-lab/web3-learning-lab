// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title LabID
 * @notice 实名身份凭证（soulbound）——硅基身份经济的信任根。
 *         对照精读：nexalink `contracts/cphs/LainID.sol`（属主仓库），机制同构。
 *
 * 三层架构的第一层「认证：谁可以被认定」：
 *   链下实名核验（KYC 机构，PII 不上链）→ 只把核验结果的哈希承诺上链
 *   → LabID 铸造（soulbound，一人 / 一 Agent 一枚）
 *   → 信号积累（SignalRegistry 写入 reputation）→ tier T0–T3 渐变能力等级
 *   → PaymentAgent 读取 tier 决定代付上限。
 *
 * 设计决策：
 *  1. soulbound：`_update` 单漏斗拦截转让。可转让的身份会被批量注册套利（女巫攻击）。
 *  2. 一地址一 ID：`idOf(addr)` 唯一，重复铸造硬拒绝。
 *  3. PII 永不上链：链上只有 tier / reputation / isAgent / 时间戳 / kycCommit 哈希。
 *  4. 碳基与硅基同构：`isAgent` 只是身份标签，不是特权开关——
 *     Agent 与人类走同一套信号协议、同一张 tier 表，T0 的 Agent 一样不能代付。
 */
contract LabID is ERC721, AccessControl {
    /// @notice 注册机构（链下核验通过后铸造）。
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    /// @notice SignalRegistry（唯一有权写 reputation 的合约）。
    bytes32 public constant SIGNAL_ROLE = keccak256("SIGNAL_ROLE");

    struct Identity {
        uint8 tier; // 当前能力等级（0-3），由 reputation 阈值推导
        uint64 mintedAt;
        bool isAgent; // true = AI 智能体身份（硅基）
        uint256 reputation; // 信号累计分
        bytes32 kycCommit; // 链下实名材料的 keccak256 承诺（不含 PII）
    }

    uint256 public nextId = 1;
    /// @notice 持有者 → tokenId（0 = 无身份）。
    mapping(address => uint256) public idOf;
    mapping(uint256 => Identity) private _identities;

    event IdentityMinted(uint256 indexed tokenId, address indexed subject, bool isAgent, bytes32 kycCommit);
    event ReputationUpdated(uint256 indexed tokenId, uint256 newReputation, int256 delta);
    event TierChanged(uint256 indexed tokenId, uint8 oldTier, uint8 newTier);

    error AlreadyHasIdentity(address subject);
    error NoIdentity(address subject);
    error UnknownIdentity(uint256 tokenId);
    error Soulbound();
    error ZeroAddress();

    constructor(address admin) ERC721("LabID", "LABID") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    // ============ 铸造（链下实名核验通过后） ============

    /**
     * @notice 铸造身份（仅 REGISTRAR）。一地址一 ID。
     * @param subject   被认定主体（人类或 Agent 地址）
     * @param isAgent   true = AI 智能体身份
     * @param kycCommit 链下实名材料哈希承诺 keccak256(材料摘要+盐)，可事后证伪
     */
    function mint(address subject, bool isAgent, bytes32 kycCommit)
        external
        onlyRole(REGISTRAR_ROLE)
        returns (uint256 tokenId)
    {
        if (subject == address(0)) revert ZeroAddress();
        if (idOf[subject] != 0) revert AlreadyHasIdentity(subject);
        tokenId = nextId++;
        idOf[subject] = tokenId;
        _identities[tokenId] = Identity({
            tier: 0, mintedAt: uint64(block.timestamp), isAgent: isAgent, reputation: 0, kycCommit: kycCommit
        });
        _mint(subject, tokenId);
        emit IdentityMinted(tokenId, subject, isAgent, kycCommit);
    }

    // ============ 信号写入口（仅 SIGNAL_ROLE = SignalRegistry） ============

    /**
     * @notice 累加声誉分并按阈值重算 tier。仅 SignalRegistry 可调。
     *         阈值：rep ≥ 2000 → T3 ｜ ≥ 500 → T2 ｜ ≥ 100 → T1 ｜ 否则 T0。
     *         负 delta 向下钳制到 0（声誉不能为负，降级即时生效）。
     */
    function addReputation(address subject, int256 delta) external onlyRole(SIGNAL_ROLE) {
        uint256 tokenId = idOf[subject];
        if (tokenId == 0) revert NoIdentity(subject);
        Identity storage id = _identities[tokenId];

        uint256 oldRep = id.reputation;
        // casting to 'uint256' is safe because 分支已保证 delta 的符号（负分支里 -delta ≤ 2^255）
        // forge-lint: disable-next-line(unsafe-typecast)
        id.reputation = delta >= 0
            ? oldRep + uint256(delta)
            // forge-lint: disable-next-line(unsafe-typecast)
            : (oldRep >= uint256(-delta) ? oldRep - uint256(-delta) : 0);

        uint8 newTier = _tierOf(id.reputation);
        if (newTier != id.tier) {
            emit TierChanged(tokenId, id.tier, newTier);
            id.tier = newTier;
        }
        emit ReputationUpdated(tokenId, id.reputation, delta);
    }

    function _tierOf(uint256 rep) internal pure returns (uint8) {
        if (rep >= 2_000) return 3;
        if (rep >= 500) return 2;
        if (rep >= 100) return 1;
        return 0;
    }

    // ============ 公开视图 ============

    function tierOf(address subject) external view returns (uint8) {
        uint256 tokenId = idOf[subject];
        return tokenId == 0 ? 0 : _identities[tokenId].tier;
    }

    function reputationOf(address subject) external view returns (uint256) {
        uint256 tokenId = idOf[subject];
        return tokenId == 0 ? 0 : _identities[tokenId].reputation;
    }

    function identityOf(uint256 tokenId) external view returns (Identity memory) {
        if (_ownerOf(tokenId) == address(0)) revert UnknownIdentity(tokenId);
        return _identities[tokenId];
    }

    // ============ soulbound（单漏斗拦截） ============

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
