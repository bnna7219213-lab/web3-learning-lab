// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title GasLab —— Gas 优化四组对照：缓存读 / calldata vs memory / unchecked / 打包写
/// @notice 每组 = naive 版 + optimized 版，测试用 gasleft() 同一交易内对账，
///         结论表落 docs/01-Gas对比表.md。
///         口径提醒（README 零 gas 语义校准）：这里报的是 **gas 消耗（gasUsed）**，
///         度量执行开销与区块容量占用，不是「费用」。
contract GasLab {
    uint256 public total;
    uint256[] public data;

    constructor(uint256 n) {
        for (uint256 i = 0; i < n; ++i) {
            data.push(i + 1);
        }
    }

    // ── 组1：循环里读 storage（naive） vs 先缓存到 memory（optimized）────────
    /// @notice naive：每次迭代都 SLOAD data.length 与 data[i]
    function sumNaive() external view returns (uint256 s) {
        for (uint256 i = 0; i < data.length; ++i) {
            s += data[i];
        }
    }

    /// @notice optimized：length 与元素各缓存一次（memory 局部变量）
    function sumCached() external view returns (uint256 s) {
        uint256[] storage cache = data;
        uint256 len = cache.length;
        for (uint256 i = 0; i < len; ++i) {
            s += cache[i];
        }
    }

    // ── 组2：calldata 直读 vs 拷进 memory 再处理 ─────────────────────────────
    /// @notice naive：外部数组先拷到 memory（分配 + 逐字拷贝）
    function countNaive(uint256[] calldata xs) external pure returns (uint256) {
        uint256[] memory ys = xs;
        uint256 c;
        for (uint256 i = 0; i < ys.length; ++i) {
            if (ys[i] % 2 == 0) ++c;
        }
        return c;
    }

    /// @notice optimized：直接 calldata 索引，零拷贝
    function countCalldata(uint256[] calldata xs) external pure returns (uint256) {
        uint256 c;
        uint256 len = xs.length;
        for (uint256 i = 0; i < len; ++i) {
            if (xs[i] % 2 == 0) ++c;
        }
        return c;
    }

    // ── 组3：有溢出检查 vs unchecked ─────────────────────────────────────────
    /// @notice naive：每次 ++i 与 += 都带溢出检查（JUMPI 分支）
    function accumulateChecked(uint256 rounds) external returns (uint256 s) {
        for (uint256 i = 0; i < rounds; ++i) {
            s += i;
        }
        total = s;
    }

    /// @notice optimized：循环边界可证不溢出时用 unchecked（require 先证界）
    function accumulateUnchecked(uint256 rounds) external returns (uint256 s) {
        require(rounds <= type(uint64).max, "rounds too big");
        unchecked {
            for (uint256 i = 0; i < rounds; ++i) {
                s += i;
            }
        }
        total = s;
    }

    // ── 组4：存储写——打包（GasLab.set vs 拆槽版在 StorageSplitDemo）──────────
    /// @notice 单字段写：naive 每次 += 重读重写；optimized 用 calldata 一次写
    function creditNaive(uint256 amount) external {
        total = total + amount;
    }

    function creditCached(uint256 amount) external {
        uint256 t = total;
        total = t + amount;
    }
}
