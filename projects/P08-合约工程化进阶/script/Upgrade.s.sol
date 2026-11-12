// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VaultV1, VaultV2} from "../src/UUPSUpgrade.sol";

/// @notice P8-S4 升级演练脚本（沿用 P05 的零私钥/anvil 解锁账户广播模式），两步跑：
///         第一步部署： forge script script/Upgrade.s.sol --sig "deployV1()" \
///                      --rpc-url http://127.0.0.1:8545 --broadcast [--sender 0x…]
///         第二步升级： forge script script/Upgrade.s.sol --sig "upgradeToV2(address)" <proxy> \
///                      --rpc-url http://127.0.0.1:8545 --broadcast [--sender 0x…]
///         升级前门禁：forge inspect VaultV1/VaultV2 storage-layout diff 只允许「吃 gap」；
///         脚本内置升级前后 slot2（totalDeposited）对账，变了直接 revert。
contract UpgradeScript is Script {
    function deployV1() external returns (address proxyAddr) {
        _broadcast();
        VaultV1 impl = new VaultV1();
        bytes memory initData = abi.encodeCall(VaultV1.initialize, (msg.sender));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vm.stopBroadcast();

        console.log(unicode"VaultV1 实现:", vm.toString(address(impl)));
        console.log(unicode"代理地址（业务入口）:", vm.toString(address(proxy)));
        console.log(unicode"owner:", vm.toString(msg.sender));
        return address(proxy);
    }

    function upgradeToV2(address proxyAddr) external {
        _broadcast();
        VaultV2 implV2 = new VaultV2();
        VaultV1 proxy = VaultV1(proxyAddr);

        require(proxy.owner() == msg.sender, unicode"sender 不是 proxy owner，无法升级");
        bytes32 beforeSlot = vm.load(proxyAddr, bytes32(uint256(2))); // totalDeposited

        proxy.upgradeToAndCall(address(implV2), "");

        bytes32 afterSlot = vm.load(proxyAddr, bytes32(uint256(2)));
        require(beforeSlot == afterSlot, unicode"升级后 totalDeposited 槽位变化——存储槽冲突！");
        vm.stopBroadcast();

        console.log(unicode"VaultV2 实现:", vm.toString(address(implV2)));
        console.log(unicode"升级后 totalDeposited 槽未变 ✓");
    }

    /// @dev 与 P05 Deploy 同款：无 DEPLOYER_PRIVATE_KEY 时用 anvil 解锁账户路径
    function _broadcast() internal {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }
    }
}
