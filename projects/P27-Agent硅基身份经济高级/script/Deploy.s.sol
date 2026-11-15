// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LabUSD} from "../src/LabUSD.sol";
import {LabID} from "../src/LabID.sol";
import {SignalRegistry} from "../src/SignalRegistry.sol";
import {PaymentAgent} from "../src/PaymentAgent.sol";

/// 部署四合约并接线角色，登记 deployments/<chainId>/P27.json（沿用 P04/P05 的 DeploymentRecorder 做法）。
/// 角色布线：LabID.SIGNAL_ROLE → SignalRegistry（唯一声誉写口）；
///           SignalRegistry.PROVIDER_ROLE → 数据提供方；PaymentAgent.AGENT_ROLE → Agent 运行时。
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        address admin = vm.envOr("CONTRACT_ADMIN", deployer);

        LabUSD usd = new LabUSD(admin);
        LabID id = new LabID(admin);
        SignalRegistry reg = new SignalRegistry(admin, address(id));
        PaymentAgent agent = new PaymentAgent(admin, address(usd), address(id));

        id.grantRole(id.SIGNAL_ROLE(), address(reg));
        reg.grantRole(reg.PROVIDER_ROLE(), vm.envOr("PROVIDER_ADDRESS", deployer));
        agent.grantRole(agent.AGENT_ROLE(), vm.envOr("AGENT_RUNTIME_ADDRESS", deployer));

        string memory verifierCsv = vm.envOr("VERIFIER_ADDRS", string(""));
        if (bytes(verifierCsv).length > 0) {
            string[] memory parts = vm.split(verifierCsv, ",");
            for (uint256 i; i < parts.length; ++i) {
                reg.addVerifier(vm.parseAddress(parts[i]));
            }
        }

        uint256 initialMint = vm.envOr("LABUSD_INITIAL_MINT", uint256(1_000_000e6));
        if (initialMint > 0) {
            usd.mint(vm.envOr("LABUSD_TREASURY", deployer), initialMint);
        }
        vm.stopBroadcast();

        string memory obj = vm.serializeString("p27", "contract", "P27");
        obj = vm.serializeUint("p27", "chainId", block.chainid);
        obj = vm.serializeAddress("p27", "deployer", deployer);
        obj = vm.serializeAddress("p27", "admin", admin);
        obj = vm.serializeAddress("p27", "labUsd", address(usd));
        obj = vm.serializeAddress("p27", "labId", address(id));
        obj = vm.serializeAddress("p27", "signalRegistry", address(reg));
        obj = vm.serializeAddress("p27", "paymentAgent", address(agent));
        obj = vm.serializeUint("p27", "initialMint", initialMint);
        obj = vm.serializeBytes32("p27", "labUsdBytecodeHash", keccak256(address(usd).code));
        obj = vm.serializeBytes32("p27", "labIdBytecodeHash", keccak256(address(id).code));
        obj = vm.serializeBytes32("p27", "signalRegistryBytecodeHash", keccak256(address(reg).code));
        obj = vm.serializeBytes32("p27", "paymentAgentBytecodeHash", keccak256(address(agent).code));
        obj = vm.serializeString("p27", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("p27", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("p27", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));
        obj = vm.serializeString("p27", "rpcUrl", vm.envOr("RPC_URL", string("")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/P27.json"));
        vm.writeJson(obj, "deployments/latest.json");

        console.log("P27 deployed (LabUSD / LabID / SignalRegistry / PaymentAgent)");
        console.log("  chainId        ", vm.toString(block.chainid));
        console.log("  admin          ", admin);
        console.log("  LabUSD         ", address(usd));
        console.log("  LabID          ", address(id));
        console.log("  SignalRegistry ", address(reg));
        console.log("  PaymentAgent   ", address(agent));
        console.log("  record         ", string.concat(dir, "/P27.json"));
    }
}