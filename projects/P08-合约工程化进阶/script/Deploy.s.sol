// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MerkleAirdrop} from "../src/MerkleAirdrop.sol";
import {GasLab} from "../src/GasLab.sol";

/// @notice P08 主部署脚本：MerkleAirdrop（root 可配）+ GasLab（gas 对比实验对象）。
///         代理升级演练两步走 script/Upgrade.s.sol（deployV1 / upgradeToV2）。
///         部署记录沿用 P04/P05 的 DeploymentRecorder 做法：deployments/<chainId>/ + latest.json，
///         指纹带 foundryProfile/evmVersion（B04 PUSH0 教训：换 profile 重编指纹必变，须随记录落盘）。
contract Deploy is Script {
    /// @dev P01 demos/merkle-proof.mjs 实测 root（13 份批次）；MERKLE_ROOT 可用环境变量覆盖
    bytes32 internal constant P01_ROOT = 0x9a70e0ab32d1a4e552a7dfbfd3eb016f769103d8226dd134125347ac6f9836d6;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }

        bytes32 root = vm.envOr("MERKLE_ROOT", P01_ROOT);
        uint256 labN = vm.envOr("GASLAB_N", uint256(64));

        MerkleAirdrop drop = new MerkleAirdrop(root);
        GasLab lab = new GasLab(labN);
        vm.stopBroadcast();

        console.log(unicode"MerkleAirdrop  ", vm.toString(address(drop)));
        console.log(unicode"  root         ", vm.toString(root));
        console.log(unicode"GasLab        ", vm.toString(address(lab)));

        _record(address(drop), "MerkleAirdrop");
        _record(address(lab), "GasLab");

        // 合并快照：latest.json 的语义必须是「当前部署的全量」，而不是「最后一个合约」。
        //   （旧实现逐合约覆写 latest.json → 只剩最后写的 GasLab，前端/脚本按 latest 读会拿不到另一个合约。）
        //   口径与 B08 的 Deploy.s.sol 一致：deployments/<chainId>/all.json + deployments/latest.json。
        string memory obj = vm.serializeAddress("rec", "MerkleAirdrop", address(drop));
        obj = vm.serializeAddress("rec", "GasLab", address(lab));
        obj = vm.serializeUint("rec", "chainId", block.chainid);
        obj = vm.serializeBytes32("rec", "merkleRoot", root);
        obj = vm.serializeString("rec", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("rec", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("rec", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/all.json"));
        vm.writeJson(obj, "deployments/latest.json");
        console.log(unicode"  record      deployments/latest.json (all contracts)");
    }

    function _record(address addr, string memory name) internal {
        string memory obj = vm.serializeAddress("rec", "address", addr);
        obj = vm.serializeUint("rec", "chainId", block.chainid);
        obj = vm.serializeBytes32("rec", "deployedBytecodeHash", keccak256(addr.code));
        obj = vm.serializeString("rec", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("rec", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("rec", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));
        obj = vm.serializeString("rec", "contract", name);

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        string memory file = string.concat(dir, "/", name, ".json");
        vm.writeJson(obj, file);
        console.log(unicode"  record      ", file);
    }
}
