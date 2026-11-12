// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StorageLayoutDemo —— 存储布局与 slot 手工计算的实验对象（P8-S2）
/// @notice 槽位设计（逐字段手工推算，测试用 vm.load 对账）：
///         slot 0: uint128 a [0..127] | uint64 b [128..191] | bool flag [192..199]
///         slot 1: address owner [0..159] | uint96 nonce [160..255]（160+96=256 正好占满）
///         slot 2: uint256 counter（独立占槽，对照「不打包」）
///         slot 3: mapping(address => uint256) balances
///                 实际数据槽 = keccak256(abi.encode(key, uint256(3)))
contract StorageLayoutDemo {
    uint128 public a;
    uint64 public b;
    bool public flag;

    address public owner;
    uint96 public nonce;

    uint256 public counter;

    mapping(address => uint256) public balances;

    /// @notice 三个小字段打包在 slot 0：一次冷 SSTORE 只发生一次（首写 20k，同交易内改写 100/2900）
    function setPacked(uint128 a_, uint64 b_, bool flag_) external {
        a = a_;
        b = b_;
        flag = flag_;
    }

    function setOwner(address owner_) external {
        owner = owner_;
        unchecked {
            ++nonce; // uint96 自增不可能溢出，去掉检查
        }
    }

    function bumpCounter() external {
        unchecked {
            ++counter;
        }
    }

    function credit(uint256 amount) external {
        balances[msg.sender] += amount;
    }
}

/// @title StorageSplitDemo —— 与 StorageLayoutDemo 字段相同但「强制不打包」的对照组
/// @notice solc 只会把「相邻且装得下」的字段打包；uint256 永远装不进剩余位，
///         所以用 uint256 垫片插在字段之间即可强制拆槽：
///         slot 0: uint128 a（b 被 _pad1 挡住进不来）
///         slot 1: uint256 _pad1
///         slot 2: uint64 b
///         slot 3: uint256 _pad2
///         slot 4: bool flag
///         slot 5: uint256 counter
///         写同样三个字段 = 3 次冷 SSTORE（20k×3）vs 打包版 1 次
contract StorageSplitDemo {
    uint128 public a;
    uint256 private _pad1;
    uint64 public b;
    uint256 private _pad2;
    bool public flag;
    uint256 public counter;

    function setSplit(uint128 a_, uint64 b_, bool flag_) external {
        a = a_;
        b = b_;
        flag = flag_;
    }

    function bumpCounter() external {
        unchecked {
            ++counter;
        }
    }
}
