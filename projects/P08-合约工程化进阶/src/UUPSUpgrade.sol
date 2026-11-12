// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @dev 最小 owner（vendored 只有 OZ 主包，主包 Ownable 是构造函数风格、无 __Ownable_init；
///      这里用与 Ownable 等价的 storage + modifier，避免引 upgradeable 包）。
abstract contract MinimalOwner is Initializable {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function __MinimalOwner_init(address owner_) internal initializer {
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, unicode"not owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), unicode"zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

/// @title VaultV1 —— UUPS 实现合约（P8-S4）
/// @notice 存储布局（`forge inspect VaultV1 storage-layout` 实测，作为升级对账基准）：
///         slot 0: owner（MinimalOwner；OZ v5 Initializable 已迁 ERC-7201 命名空间存储，
///                 _initialized 不占常规槽——v4 教程里「slot0 是 _initialized」的说法在 v5 不成立）
///         slot 1: uint256 version（V1 写 1）
///         slot 2: uint256 totalDeposited
///         slot 3..48: __gap（uint256[46]）
///         ERC-1967 固定槽（实现地址 0x3608… / 管理地址 0xb531… / init 码哈希 0xa3f0…）
///         与上述状态槽不重叠——冲突检查在 Upgrade.t.sol 用 vm.load 逐槽验证。
contract VaultV1 is MinimalOwner, UUPSUpgradeable {
    uint256 public version;
    uint256 public totalDeposited;

    /// @dev 标准 gap 做法：新变量只能吃 gap，不能插在已有变量前面
    uint256[46] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external {
        __MinimalOwner_init(owner_);
        version = 1;
    }

    function deposit() external payable {
        totalDeposited += msg.value;
    }

    /// @notice UUPS 的安全门：只有 owner 能批准新实现
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

/// @title VaultV2 —— 升级后的实现：只「追加」新变量，不动旧变量位置
/// @notice 布局规则（存储槽冲突检查的核心）：✅ 追加字段/吃 gap  ❌ 调整顺序/删字段/改类型
contract VaultV2 is MinimalOwner, UUPSUpgradeable {
    uint256 public version;
    uint256 public totalDeposited;

    // —— 追加：从原 __gap 里吃 2 个槽（46→44），旧字段位置不动 ——
    uint256 public totalWithdrawn;
    mapping(address => uint256) public lastDepositBlock;

    uint256[44] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external {
        __MinimalOwner_init(owner_);
    }

    function deposit() external payable {
        totalDeposited += msg.value;
        lastDepositBlock[msg.sender] = block.number;
    }

    event Withdrawn(address indexed who, uint256 amount);

    function withdraw(uint256 amount) external onlyOwner {
        totalWithdrawn += amount;
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice 迁移：V1→V2 后的一次性状态补写（幂等由版本号保证）
    function migrateFromV1() external {
        require(version == 1, unicode"already migrated");
        version = 2;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

/// @title VaultBadV2 —— 反例：把新变量插在旧变量前面（制造存储槽冲突）
/// @notice 实测布局：totalWithdrawn 落 slot 2（V1 里是 totalDeposited 的槽），
///         BadV2 自己的 totalDeposited 被挤到 slot 3（旧 gap）——
///         升级后「存的钱」在 getter totalWithdrawn 里出现，
///         而 totalDeposited 读出 0。测试用它证明为什么新变量只能追加/吃 gap。
contract VaultBadV2 is MinimalOwner, UUPSUpgradeable {
    uint256 public version;
    // ⚠️ 故意插队：V1 里 slot 2 是 totalDeposited
    uint256 public totalWithdrawn;
    uint256 public totalDeposited;

    uint256[45] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external {
        __MinimalOwner_init(owner_);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
