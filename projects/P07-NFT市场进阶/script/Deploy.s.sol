// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LabNFT} from "../src/LabNFT.sol";
import {LabEditions} from "../src/LabEditions.sol";
import {NFTMarket} from "../src/NFTMarket.sol";

/// 部署三件套并登记（P04 同款 Recorder）。tradingEnabled 保持默认 false：
/// 合规要求二级市场入口默认关闭，开启是部署后的显式治理动作（前端 admin 面板或 cast）。
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
        address royaltyReceiver = vm.envOr("ROYALTY_RECEIVER", deployer);
        uint96 bps = uint96(vm.envOr("ROYALTY_BPS", uint256(500)));

        LabNFT nft = new LabNFT(admin, "LabNFT", "LNFT", royaltyReceiver, bps);
        LabEditions editions = new LabEditions(admin, royaltyReceiver, bps);
        NFTMarket market = new NFTMarket(admin);
        vm.stopBroadcast();

        string memory obj = vm.serializeString("record", "project", "P07");
        obj = vm.serializeAddress("record", "nft", address(nft));
        obj = vm.serializeAddress("record", "editions", address(editions));
        obj = vm.serializeAddress("record", "market", address(market));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeAddress("record", "royaltyReceiver", royaltyReceiver);
        obj = vm.serializeUint("record", "royaltyBps", bps);
        obj = vm.serializeBool("record", "tradingEnabled", market.tradingEnabled());
        obj = vm.serializeBytes32("record", "nftBytecodeHash", keccak256(address(nft).code));
        obj = vm.serializeBytes32("record", "marketBytecodeHash", keccak256(address(market).code));
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/P07.json"));
        vm.writeJson(obj, "deployments/latest.json");

        console.log("P07 deployed");
        console.log("  nft      ", vm.toString(address(nft)));
        console.log("  editions ", vm.toString(address(editions)));
        console.log("  market   ", vm.toString(address(market)));
        console.log("  admin    ", vm.toString(admin));
        console.log("  trading  ", market.tradingEnabled() ? "ON" : "OFF (default, compliance)");
    }
}
