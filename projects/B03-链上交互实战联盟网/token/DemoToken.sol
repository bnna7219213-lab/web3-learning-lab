// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// B03 演示代币 DemoToken（DEMO）· 标准 ERC-20 + 单角色 mint
/// 用途：给私有链浏览器的「代币页」提供可索引的 Transfer 事件与持仓分布数据。
/// 说明：手裁最小子集（不引 OpenZeppelin，避免依赖链），接口与 ERC-20 标准一致。
contract DemoToken {
    // constant 字符串：编译期常量化，构造函数为空（避免 solc 0.8.x 的 abi 解码 helper 烧光 gas）
    string public constant name = "DemoToken";
    string public constant symbol = "DEMO";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public owner; // 可 mint 的运营方（部署者）

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        owner = msg.sender;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external {
        require(msg.sender == owner, "not owner");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value); // mint: from=0x0
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
