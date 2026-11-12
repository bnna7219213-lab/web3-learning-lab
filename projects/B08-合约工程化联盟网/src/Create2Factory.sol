// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Create2Factory —— CREATE2 确定性地址实验（P8-S3）
/// @notice 地址公式（EIP-1014）：
///         address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
///         三个输入任一变化 → 地址全变。测试用 vm.computeCreate2Address 对账。
contract Create2Factory {
    event Deployed(address indexed addr, bytes32 indexed salt, uint256 deployCount);

    mapping(bytes32 => address) public deployedBySalt;
    uint256 public deployCount;

    error AddressAlreadyUsed(bytes32 salt);
    error DeployFailed();

    /// @notice 用固定 salt + initCode 部署，地址完全由部署前的三项输入决定
    function deploy(bytes32 salt, bytes memory initCode) external returns (address addr) {
        if (deployedBySalt[salt] != address(0)) revert AddressAlreadyUsed(salt);
        assembly {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        deployedBySalt[salt] = addr;
        unchecked {
            ++deployCount;
        }
        emit Deployed(addr, salt, deployCount);
    }

    /// @notice 纯计算：与链上 create2 完全同一公式，链下预计算用
    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}

/// @title Beacon —— 被 CREATE2 部署的目标（无构造参数，initCode 稳定）
contract Beacon {
    uint256 public immutable tag;

    constructor(uint256 tag_) {
        tag = tag_;
    }

    function ping() external pure returns (string memory) {
        return "beacon";
    }
}
