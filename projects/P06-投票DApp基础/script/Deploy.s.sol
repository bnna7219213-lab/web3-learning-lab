// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Voting} from "../src/Voting.sol";

/// 部署并登记（P04/P05 同款 DeploymentRecorder）：admin 外置，指纹随编译参数落盘。
contract Deploy is Script {
    function run() external returns (Voting deployed) {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        address admin = vm.envOr("CONTRACT_ADMIN", address(0));
        if (admin == address(0)) admin = deployer;

        deployed = new Voting(admin);
        vm.stopBroadcast();

        string memory obj = vm.serializeString("record", "contract", "Voting");
        obj = vm.serializeAddress("record", "address", address(deployed));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "deployer", deployer);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeBytes32("record", "deployedBytecodeHash", keccak256(address(deployed).code));
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));
        obj = vm.serializeString("record", "rpcUrl", vm.envOr("RPC_URL", string("")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/Voting.json"));
        vm.writeJson(obj, "deployments/latest.json");

        console.log("Voting deployed");
        console.log("  chainId     ", vm.toString(block.chainid));
        console.log("  address     ", vm.toString(address(deployed)));
        console.log("  admin       ", vm.toString(admin));
        console.log("  bytecodeHash", vm.toString(keccak256(address(deployed).code)));
    }
}
