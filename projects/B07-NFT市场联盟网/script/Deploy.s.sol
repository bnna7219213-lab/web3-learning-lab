// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LabCredential} from "../src/LabCredential.sol";

/// @notice 部署权益凭证合约并登记（P04/P07 同款 Recorder）。
/// @dev 联盟网注意：
///      - 必须 FOUNDRY_PROFILE=consortium（london 指令集），否则字节码含 PUSH0 → 进块但 status=0；
///      - 必须 --legacy --gas-price 0（零 gas 网络）+ 显式 --gas-limit（成员账户余额为 0，
///        eth_estimateGas 会因余额不足直接失败，gas 估算这一步过不去）。
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        address admin = vm.envOr("CONTRACT_ADMIN", address(0));
        if (admin == address(0)) admin = deployer;

        LabCredential cred = new LabCredential(admin);
        vm.stopBroadcast();

        string memory obj = vm.serializeString("record", "project", "B07");
        obj = vm.serializeAddress("record", "credential", address(cred));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeBytes32("record", "bytecodeHash", keccak256(address(cred).code));
        obj = vm.serializeUint("record", "maxBatchSize", cred.MAX_BATCH_SIZE());
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/B07.json"));
        vm.writeJson(obj, "deployments/latest.json");

        console.log("B07 deployed");
        console.log("  credential ", vm.toString(address(cred)));
        console.log("  admin      ", vm.toString(admin));
        console.log("  chainId    ", vm.toString(block.chainid));
    }
}
