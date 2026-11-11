// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice 学习用记账单位（LAB），不是可交易代币：无行情、无兑换、无募资语义。
///         设计边界写进源码（P04 对照精读 Faucet.sol 的教训）：任何真实价值不得锚定本合约。
/// @dev 权限外置：admin 由构造参数传入（部署脚本可填客户多签），不写死 msg.sender。
///      上限在 _update 钩子强制，mint 是唯一增发入口；burn 走 ERC20Burnable（持币人自毁）。
contract LabToken is ERC20, ERC20Burnable, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    string public constant VERSION = "1.0.0";

    uint256 public immutable CAP;

    error CapExceeded(uint256 cap, uint256 attempted);
    error ZeroAdmin();
    error ZeroCap();

    constructor(address admin, uint256 cap) ERC20("Learning Lab Token", "LAB") ERC20Permit("Learning Lab Token") {
        if (admin == address(0)) revert ZeroAdmin();
        if (cap == 0) revert ZeroCap();
        CAP = cap;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @dev OZ v5 的唯一转账钩子：mint/burn/transfer 都经过这里，上限只在这一处查。
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            uint256 attempted = totalSupply() + value;
            if (attempted > CAP) revert CapExceeded(CAP, attempted);
        }
        super._update(from, to, value);
    }

    /// @notice 按持仓比例分摊 pool 的报价（空投/奖励分发预览，P19 Merkle 空投的算术前置）。
    /// @dev 向下取整： dust 留在池里而非超发——协议侧有利的舍入方向，P17/P18 会量化另一侧。
    function quoteProRata(uint256 pool, address account) external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return Math.mulDiv(pool, balanceOf(account), supply, Math.Rounding.Floor);
    }
}
