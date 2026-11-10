// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Counter — P04 的最小可验证合约
/// @notice 刻意做小，但把「事件 / 自定义 error / 权限 / 存储成本」四件事一次齐：
///         这四件事正是 P08(Gas 与存储)、P19(治理)、B04(账户权限) 的接口点。
contract Counter {
    string public constant VERSION = "1.0.0";

    uint256 public count;
    address public owner;

    /// @dev 保留最近 N 次变更，用来在 P08 里对比「数组存储 vs 只存终值」的 gas 差
    uint256 public constant HISTORY_LEN = 8;
    uint256[HISTORY_LEN] private _history;
    uint256 private _historyPtr;

    event Incremented(address indexed actor, uint256 from, uint256 to, uint256 by);
    event Reset(address indexed actor, uint256 previousCount);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    error NotOwner(address caller);
    error ZeroIncrement();
    error Overflow(uint256 previous, uint256 by);

    /// @param initial 初始计数
    /// @param admin   管理者地址。刻意外置而不是用 msg.sender：
    ///                B04 部署到联盟网时应设成客户方多签，而不是我们跑部署脚本的账户
    ///                （对照 lainchain `Faucet.sol` 的 `constructor(..., address admin)`）
    constructor(uint256 initial, address admin) {
        owner = admin;
        count = initial;
        emit Incremented(msg.sender, 0, initial, initial);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    function increment(uint256 by) external {
        if (by == 0) revert ZeroIncrement();
        uint256 previous = count;
        unchecked {
            // 0.8 默认会溢出 revert；这里显式检查是为了给出可读错误 + 少一层隐式检查开销（P08 会量化差多少）
            uint256 next = previous + by;
            if (next < previous) revert Overflow(previous, by);
            count = next;
        }
        _record(previous);
        emit Incremented(msg.sender, previous, count, by);
    }

    function reset() external onlyOwner {
        uint256 previous = count;
        count = 0;
        emit Reset(msg.sender, previous);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice 最近一次变更前的值（演示 view 函数不花 gas）
    function previousCount() external view returns (uint256) {
        uint256 idx = (_historyPtr + HISTORY_LEN - 1) % HISTORY_LEN;
        return _history[idx];
    }

    function history() external view returns (uint256[HISTORY_LEN] memory) {
        return _history;
    }

    function _record(uint256 value) private {
        _history[_historyPtr] = value;
        _historyPtr = (_historyPtr + 1) % HISTORY_LEN;
    }
}
