// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title LabCredential · 联盟内权益凭证
/// @notice P07 NFT 市场的**语义收缩版**：不是藏品，是成员之间的权益凭证。
/// @dev 与 P07 的四处关键差异：
///      1. 转让白名单：只有联盟成员（isMember）之间才能流转 —— 这就是「禁二级」的落地方式
///         （没有市场合约、没有价格字段，且非成员根本收不到/转不出）；
///      2. 元数据不出域：链上只锚定**内容哈希树的根**（复用 shared/evidence 的 Merkle v2 结构），
///         具体 JSON 放内网对象存储，tokenURI 由 baseURI + tokenId 推导；
///      3. 到期自动回收 0 例外：凭证带 validUntil，过期即失效（转让/核销一律被拒），
///         不依赖任何人来「收回」；任何人可调用 sweepExpired 做链上清理并留痕；
///      4. 审计留痕：被拒的转让走 checkTransfer（只读预检）+ recordBlockedTransfer（写审计），
///         失败交易本身也在链上（status=0 + 自定义 error），两者可交叉核对。
contract LabCredential is ERC721, ERC721Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant REDEEMER_ROLE = keccak256("REDEEMER_ROLE");
    bytes4 private constant _IERC4907_ID = 0xad092b5c;

    /// @notice 单笔发行上限：受 EIP-7825 单笔 gas 上限（16,777,216）约束。
    /// @dev 1000 份不可能塞进一笔交易 —— 每个 ERC721 mint 至少两次 SSTORE（owner + balance），
    ///      约 44k gas/份，1000 份 ≈ 44M gas，远超上限。所以发行按批次分笔，脚本负责凑够 1000。
    uint16 public constant MAX_BATCH_SIZE = 250;

    bytes32 public constant REASON_NOT_MEMBER_FROM = keccak256("NOT_MEMBER_FROM");
    bytes32 public constant REASON_NOT_MEMBER_TO = keccak256("NOT_MEMBER_TO");
    bytes32 public constant REASON_EXPIRED = keccak256("EXPIRED");
    bytes32 public constant REASON_NOT_TRANSFERABLE = keccak256("NOT_TRANSFERABLE");

    struct Batch {
        uint256 startId; // 起始 tokenId
        uint16 count; // 份数
        bytes32 merkleRoot; // 元数据内容哈希树根（哈希锚定，数据不出内网）
        string baseURI; // 内网对象存储基址，如 http://127.0.0.1:8088/cred/
        uint64 validUntil; // 有效期（0 = 长期有效）
        bool transferable; // 是否允许成员间流转
        address issuer; // 发行方
    }

    struct ProofStep {
        bytes32 sibling;
        uint8 level;
        bool siblingOnLeft;
    }

    struct AuditEntry {
        address actor;
        address from;
        address to;
        uint256 tokenId;
        bytes32 reason;
        uint64 at;
    }

    uint256 public nextId;
    uint256 public batchCount;
    mapping(uint256 => Batch) public batches;
    mapping(address => bool) public isMember;

    // EIP-4907：owner 是产权，user 是限期使用权
    mapping(uint256 => address) private _users;
    mapping(uint256 => uint64) private _expires;

    uint256 public auditCount;
    mapping(uint256 => AuditEntry) public auditEntries;
    uint256 public sweptCount;

    event MemberUpdated(address indexed account, bool member);
    event CredentialIssued(uint256 indexed batchId, uint256 indexed startId, uint16 count, bytes32 merkleRoot, address indexed issuer);
    event TransferBlocked(address indexed actor, address indexed from, address indexed to, uint256 tokenId, bytes32 reason);
    event Redeemed(uint256 indexed tokenId, address indexed holder, address indexed redeemer);
    event ExpiredSwept(uint256 indexed tokenId, address indexed holder, address indexed sweeper);
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    error NotMember(address account);
    error CredentialExpired(uint256 tokenId);
    error NotTransferable(uint256 tokenId);
    error BatchTooLarge(uint16 count);
    error BatchEmpty();
    error NotCredentialHolder(uint256 tokenId, address caller);

    constructor(address admin) ERC721("Lab Credential", "LCR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(REDEEMER_ROLE, admin);
    }

    // ---------------- 成员白名单 ----------------

    function setMember(address account, bool member) external onlyRole(DEFAULT_ADMIN_ROLE) {
        isMember[account] = member;
        emit MemberUpdated(account, member);
    }

    function setMembers(address[] calldata accounts, bool member) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            isMember[accounts[i]] = member;
            emit MemberUpdated(accounts[i], member);
        }
    }

    // ---------------- 发行 ----------------

    /// @notice 批量发行：一次发 count 份，链上锚定元数据哈希树根
    function mintBatch(
        address to,
        uint16 count,
        string calldata baseURI_,
        bytes32 merkleRoot,
        uint64 validUntil,
        bool transferable
    ) external onlyRole(MINTER_ROLE) returns (uint256 startId) {
        if (count == 0) revert BatchEmpty();
        if (count > MAX_BATCH_SIZE) revert BatchTooLarge(count);
        if (!isMember[to]) revert NotMember(to);

        uint256 batchId = batchCount++;
        startId = nextId;
        nextId += count;

        batches[batchId] = Batch({
            startId: startId,
            count: count,
            merkleRoot: merkleRoot,
            baseURI: baseURI_,
            validUntil: validUntil,
            transferable: transferable,
            issuer: msg.sender
        });

        for (uint256 i = 0; i < count; i++) {
            _safeMint(to, startId + i);
        }
        emit CredentialIssued(batchId, startId, count, merkleRoot, msg.sender);
    }

    /// @notice 查询 token 属于哪个批次（按批次倒序扫，批次数是发卡量级，view 足够）
    /// @dev 必须 public：Solidity 不允许按名内部调用 external 函数（要 this.xxx() 外部调用）
    function batchOf(uint256 tokenId) public view returns (uint256 batchId) {
        for (uint256 i = batchCount; i > 0; i--) {
            Batch storage b = batches[i - 1];
            if (tokenId >= b.startId && tokenId < b.startId + b.count) return i - 1;
        }
        revert("no batch");
    }

    // ---------------- 元数据（内网对象存储 + 哈希锚定） ----------------

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        uint256 batchId = batchOf(tokenId);
        Batch storage b = batches[batchId];
        return string.concat(b.baseURI, Strings.toString(tokenId), ".json");
    }

    /// @notice 凭证所属批次的元数据哈希树根（锚定在链上的那一枚）
    function merkleRootOf(uint256 tokenId) external view returns (bytes32) {
        return batches[batchOf(tokenId)].merkleRoot;
    }

    /// @notice 复刻 shared/evidence 的 Merkle v2（sha256 + 域分隔 + 位置绑定），链上验证明
    /// @param leafHash 叶子哈希（链下算好：leafAt(index, metadataJson)）
    /// @param proof     兄弟节点序列，每步给出 level 与兄弟所在侧
    function verifyProof(uint256 tokenId, bytes32 leafHash, ProofStep[] calldata proof)
        external
        view
        returns (bool ok, bytes32 recomputedRoot)
    {
        bytes32 root = batches[batchOf(tokenId)].merkleRoot;
        bytes32 cur = leafHash;
        uint256 leafIndex = 0;
        for (uint256 i = 0; i < proof.length; i++) {
            ProofStep calldata s = proof[i];
            // 兄弟在左 ⇒ 本节点在右 ⇒ 该层下标为奇数 ⇒ index 的第 level 位是 1
            if (s.siblingOnLeft) leafIndex += 2 ** s.level;
        }
        for (uint256 i = 0; i < proof.length; i++) {
            ProofStep calldata s = proof[i];
            uint256 q = leafIndex / (2 ** s.level);
            bool isRight = (q % 2) == 1;
            bytes32 left = isRight ? s.sibling : cur;
            bytes32 right = isRight ? cur : s.sibling;
            cur = nodeHash(s.level, q / 2, left, right);
        }
        recomputedRoot = cur;
        ok = (cur == root);
    }

    /// @dev 与 shared/evidence/lib/merkle-indexed.js 的 nodeHash 完全一致：
    ///      sha256("N" ‖ u8(level) ‖ u32(index) ‖ left ‖ right)
    ///      索引是节点在所在层的槽位，批量规模上限 2^32，实际不可能截断
    // forge-lint: disable-next-line(unsafe-typecast)
    function nodeHash(uint8 level, uint256 index, bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("N", level, uint32(index), left, right));
    }

    // ---------------- 有效期与自动回收 ----------------

    function validUntil(uint256 tokenId) external view returns (uint64) {
        return batches[batchOf(tokenId)].validUntil;
    }

    function isExpired(uint256 tokenId) public view returns (bool) {
        uint64 until = batches[batchOf(tokenId)].validUntil;
        return until != 0 && block.timestamp >= until;
    }

    function isValid(uint256 tokenId) external view returns (bool) {
        return !isExpired(tokenId);
    }

    /// @notice 到期清理：任何人可调用，把过期凭证销掉并留痕（**0 例外**指失效判定不依赖本函数，
    ///         本函数只是把「已失效」这件事在链上显式化 + 清理占用）
    function sweepExpired(uint256[] calldata tokenIds) external returns (uint256 swept) {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (!isExpired(id)) continue;
            address holder = ownerOf(id);
            _burn(id);
            sweptCount++;
            swept++;
            emit ExpiredSwept(id, holder, msg.sender);
        }
    }

    // ---------------- 核销 ----------------

    /// @notice 核销：商户把已使用的凭证销掉（权益已兑现）
    function redeem(uint256 tokenId) external onlyRole(REDEEMER_ROLE) {
        if (isExpired(tokenId)) revert CredentialExpired(tokenId);
        address holder = ownerOf(tokenId);
        _burn(tokenId);
        emit Redeemed(tokenId, holder, msg.sender);
    }

    // ---------------- 转让策略（禁二级） ----------------

    /// @notice 转让预检（只读）：返回是否放行与拒绝原因码
    /// @dev DApp 在调用 transferFrom 前先跑这个：不允许就调 recordBlockedTransfer 留痕，
    ///      再由 transferFrom 自己 revert —— 失败交易（status=0 + error）与审计记录可交叉核对。
    function checkTransfer(address from, address to, uint256 tokenId)
        external
        view
        returns (bool allowed, bytes32 reason)
    {
        if (isExpired(tokenId)) return (false, REASON_EXPIRED);
        Batch storage b = batches[batchOf(tokenId)];
        if (!b.transferable) return (false, REASON_NOT_TRANSFERABLE);
        if (!isMember[from]) return (false, REASON_NOT_MEMBER_FROM);
        if (!isMember[to]) return (false, REASON_NOT_MEMBER_TO);
        return (true, bytes32(0));
    }

    /// @notice 审计留痕：记录一次被拒的转让尝试
    function recordBlockedTransfer(address from, address to, uint256 tokenId, bytes32 reason) external {
        auditCount++;
        auditEntries[auditCount] = AuditEntry({
            actor: msg.sender,
            from: from,
            to: to,
            tokenId: tokenId,
            reason: reason,
            at: uint64(block.timestamp)
        });
        emit TransferBlocked(msg.sender, from, to, tokenId, reason);
    }

    /// @notice EIP-4907 设置限期使用权
    function setUser(uint256 tokenId, address user, uint64 expires) external {
        address owner = ownerOf(tokenId);
        if (!_isAuthorized(owner, msg.sender, tokenId)) revert NotCredentialHolder(tokenId, msg.sender);
        if (isExpired(tokenId)) revert CredentialExpired(tokenId);
        _users[tokenId] = user;
        _expires[tokenId] = expires;
        emit UpdateUser(tokenId, user, expires);
    }

    function userOf(uint256 tokenId) external view returns (address) {
        if (_expires[tokenId] >= block.timestamp) return _users[tokenId];
        return address(0); // 到期即失效：不需要任何人来"收回"权限
    }

    function userExpires(uint256 tokenId) external view returns (uint64) {
        return _expires[tokenId];
    }

    // ---------------- overrides ----------------

    /// @dev 转让策略在 OZ v5 的唯一转移钩子 `_update` 里强制（v5 已移除 _beforeTokenTransfer）：
    ///      成员白名单 + 有效期 + 可转让标记。mint（from==0）与 burn（to==0）不受转让策略约束。
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (isExpired(tokenId)) revert CredentialExpired(tokenId);
            Batch storage b = batches[batchOf(tokenId)];
            if (!b.transferable) revert NotTransferable(tokenId);
            if (!isMember[from]) revert NotMember(from);
            if (!isMember[to]) revert NotMember(to);
            // 转让清空租约：新持有人不应被旧 user 占用
            delete _users[tokenId];
            delete _expires[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == _IERC4907_ID || super.supportsInterface(interfaceId);
    }
}
