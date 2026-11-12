// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MerkleAirdrop} from "../src/MerkleAirdrop.sol";
import {GasLab} from "../src/GasLab.sol";
import {Create2Factory} from "../src/Create2Factory.sol";
import {VaultV1, VaultV2} from "../src/UUPSUpgrade.sol";

/// @notice B08 一键部署：MerkleAirdrop + GasLab + Create2Factory + UUPS VaultV1(代理)。
///         每个实验对象一个地址，写 deployments/19880601/ + latest.json（前端直接读）。
///         升级到 V2 走 script/Upgrade.s.sol 的两步演练（全成员参与窗口见验收脚本 07）。
///         联盟网三条硬规矩：london 编译（避开 PUSH0）/ 零 gas legacy / 显式 gasLimit。
contract Deploy is Script {
    /// @dev P01 demos/merkle-proof.mjs 实测 root（13 份批次）；MERKLE_ROOT 可覆盖
    bytes32 internal constant P01_ROOT = 0x9a70e0ab32d1a4e552a7dfbfd3eb016f769103d8226dd134125347ac6f9836d6;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        // ⚠️ startBroadcast(pk) 只改「谁签交易」，脚本里的 msg.sender 仍是 forge 默认 sender
        //    （0x1804c8…）——直接 msg.sender 当 owner 会把权限锁死给无人控制的地址。
        //    owner 必须显式取 vm.addr(pk)（P05 Deploy 同款教训）。
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }

        bytes32 root = vm.envOr("MERKLE_ROOT", P01_ROOT);
        uint256 labN = vm.envOr("GASLAB_N", uint256(64));

        MerkleAirdrop drop = new MerkleAirdrop(root);
        GasLab lab = new GasLab(labN);
        Create2Factory factory = new Create2Factory();

        VaultV1 impl = new VaultV1();
        bytes memory initData = abi.encodeCall(VaultV1.initialize, (deployer));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);

        vm.stopBroadcast();

        console.log(unicode"MerkleAirdrop  ", vm.toString(address(drop)));
        console.log(unicode"GasLab        ", vm.toString(address(lab)));
        console.log(unicode"Create2Factory", vm.toString(address(factory)));
        console.log(unicode"VaultV1 实现  ", vm.toString(address(impl)));
        console.log(unicode"Vault 代理    ", vm.toString(address(proxy)));

        // 一次写全（前端 config 读 latest.json 的四个字段 + vaultImpl/vaultProxy）
        string memory obj = vm.serializeAddress("rec", "MerkleAirdrop", address(drop));
        obj = vm.serializeAddress("rec", "GasLab", address(lab));
        obj = vm.serializeAddress("rec", "Create2Factory", address(factory));
        obj = vm.serializeAddress("rec", "vaultImpl", address(impl));
        obj = vm.serializeAddress("rec", "vaultProxy", address(proxy));
        obj = vm.serializeUint("rec", "chainId", block.chainid);
        obj = vm.serializeAddress("rec", "deployer", deployer);
        obj = vm.serializeBytes32("rec", "merkleRoot", root);
        obj = vm.serializeString("rec", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("rec", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("london")));
        obj = vm.serializeString("rec", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/all.json"));
        vm.writeJson(obj, "deployments/latest.json");
        console.log(unicode"record        deployments/latest.json");
    }
}
