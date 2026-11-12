// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LabFaucet · 联盟链水龙头额度合约
/// @notice 把「每日能发多少 B03」从**服务端常量 + 本地记账**搬回链上。
/// @dev 为什么要上链（B03 × B07 预算治理衔接）：
///
///      1. 原实现里每日 500 B03 额度是 faucet/server.js 里的常量，用量记在本地
///         claims.json 的 `spent` 字段里 —— 谁改一下本地文件，额度就能被重置。
///         而链上原生转账不产生日志，历史状态又被 Besu 剪枝（只有 latest 可读），
///         服务端**没有可靠办法**从链上把「当日已发放」算出来；
///      2. 额度一旦由合约强制，剩余额度就是 `eth_call` 一次能读到的链上事实，
///         任何第三方拿同一个 RPC 都能独立复核，B03 水龙头与 B07 发证服务读的是同一份事实；
///      3. 治理参数（每日额度/单次金额/冷却）由 admin 在链上可改，改动留事件痕迹，
///         不必重启服务、不必改代码。
///
///      额度口径与原服务端一致：
///      - 每日额度 dailyCap 按 **UTC 日切**（day = block.timestamp / 1 days）；
///      - 单次领取 amountPerClaim（默认 10 B03）；
///      - 每地址冷却 cooldownSeconds（默认 60s），**链上强制**，重启服务不再清零。
contract LabFaucet {
    address public admin;

    /// @notice 每日额度（wei 级原生币）。0 表示暂停发放。
    uint256 public dailyCap;
    /// @notice 单次领取金额。
    uint256 public amountPerClaim;
    /// @notice 同一地址两次领取的最小间隔（秒）。
    uint32 public cooldownSeconds;

    /// @notice 累计发放总额（wei）。
    uint256 public totalPaid;
    /// @notice 累计发放笔数。
    uint256 public totalClaims;

    /// @notice 按 UTC 日切的当日已发放金额：day => 已发放（wei）。
    mapping(uint256 => uint256) public spentByDay;
    /// @notice 每个地址的上次领取时间（block.timestamp）。
    mapping(address => uint256) public lastClaimAt;
    /// @notice 每个地址的累计领取笔数。
    mapping(address => uint256) public claimsByAddress;
    /// @notice 每个地址的累计领取金额。
    mapping(address => uint256) public receivedByAddress;

    event Payout(address indexed to, uint256 amount, uint256 day, uint256 spentAfter);
    event PolicyUpdated(uint256 dailyCap, uint256 amountPerClaim, uint32 cooldownSeconds);
    event Funded(address indexed from, uint256 amount);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    error NotAdmin();
    error InvalidAddress();
    error InvalidPolicy();
    error DailyCapExceeded(uint256 spent, uint256 cap, uint256 amount);
    error CooldownActive(uint256 waitSeconds);
    error InsufficientBalance(uint256 have, uint256 need);

    constructor(address admin_, uint256 dailyCap_, uint256 amountPerClaim_, uint32 cooldownSeconds_) {
        if (admin_ == address(0)) revert InvalidAddress();
        // dailyCap_ == 0 允许：表示「暂停发放」这种治理动作
        if (amountPerClaim_ == 0 || (dailyCap_ != 0 && dailyCap_ < amountPerClaim_)) revert InvalidPolicy();
        admin = admin_;
        dailyCap = dailyCap_;
        amountPerClaim = amountPerClaim_;
        cooldownSeconds = cooldownSeconds_;
        emit PolicyUpdated(dailyCap_, amountPerClaim_, cooldownSeconds_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @notice 当前 UTC 日编号（block.timestamp / 1 days）——与服务端 utcDay() 口径一致。
    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice 领取额度。
    /// @dev 任何人可调用（这是水龙头，本来就是公开的）；额度与冷却由链上强制，
    ///      所以绕过 HTTP 服务直接发交易也突破不了当日额度与冷却。
    function claim(address to) external returns (uint256 amount) {
        if (to == address(0)) revert InvalidAddress();
        amount = amountPerClaim;
        uint256 day = currentDay();
        uint256 spent = spentByDay[day];
        if (spent + amount > dailyCap) revert DailyCapExceeded(spent, dailyCap, amount);

        uint256 last = lastClaimAt[to];
        if (last != 0) {
            uint256 next = last + cooldownSeconds;
            if (block.timestamp < next) revert CooldownActive(next - block.timestamp);
        }

        uint256 have = address(this).balance;
        if (have < amount) revert InsufficientBalance(have, amount);

        // checks-effects-interactions：先把状态写完再转账，避免重入时读到旧额度
        uint256 spentAfter = spent + amount;
        spentByDay[day] = spentAfter;
        lastClaimAt[to] = block.timestamp;
        claimsByAddress[to] += 1;
        receivedByAddress[to] += amount;
        totalPaid += amount;
        totalClaims += 1;

        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert InsufficientBalance(have, amount);

        emit Payout(to, amount, day, spentAfter);
    }

    /// @notice 治理参数调整（链上可查、事件留痕）。
    function setPolicy(uint256 dailyCap_, uint256 amountPerClaim_, uint32 cooldownSeconds_) external onlyAdmin {
        // dailyCap_ == 0 允许：运营方可在链上一键暂停发放
        if (amountPerClaim_ == 0 || (dailyCap_ != 0 && dailyCap_ < amountPerClaim_)) revert InvalidPolicy();
        dailyCap = dailyCap_;
        amountPerClaim = amountPerClaim_;
        cooldownSeconds = cooldownSeconds_;
        emit PolicyUpdated(dailyCap_, amountPerClaim_, cooldownSeconds_);
    }

    /// @notice 转移管理员。
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice 充值（运营方往合约里打币）。
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice 直接把币打到合约地址也算充值（运维顺手转账不该失败、更不该丢账）。
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice 当日额度总览：B03 水龙头与 B07 发证服务读的是这同一份链上事实。
    function dailyInfo()
        external
        view
        returns (
            uint256 day,
            uint256 spent,
            uint256 remaining,
            uint256 cap,
            uint256 amountPerClaim_,
            uint256 contractBalance
        )
    {
        day = currentDay();
        spent = spentByDay[day];
        cap = dailyCap;
        remaining = cap > spent ? cap - spent : 0;
        amountPerClaim_ = amountPerClaim;
        contractBalance = address(this).balance;
    }

    /// @notice 单地址可领性预检（供服务在发交易前先给出友好原因码）。
    function claimable(address to)
        external
        view
        returns (bool canClaim, uint256 waitSeconds, uint256 remaining, uint256 reason)
    {
        uint256 day = currentDay();
        uint256 spent = spentByDay[day];
        remaining = dailyCap > spent ? dailyCap - spent : 0;
        if (to == address(0)) {
            return (false, 0, remaining, 1); // 1 = 地址非法
        }
        if (amountPerClaim == 0 || dailyCap == 0) {
            return (false, 0, remaining, 2); // 2 = 政策暂停
        }
        if (remaining < amountPerClaim) {
            return (false, 0, remaining, 3); // 3 = 今日额度已用完
        }
        uint256 last = lastClaimAt[to];
        if (last != 0) {
            uint256 next = last + cooldownSeconds;
            if (block.timestamp < next) {
                return (false, next - block.timestamp, remaining, 4); // 4 = 冷却中
            }
        }
        if (address(this).balance < amountPerClaim) {
            return (false, 0, remaining, 5); // 5 = 合约余额不足
        }
        return (true, 0, remaining, 0);
    }
}
