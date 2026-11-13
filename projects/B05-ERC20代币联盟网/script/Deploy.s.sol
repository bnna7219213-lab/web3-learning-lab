// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LabToken} from "../src/LabToken.sol";

/// 部署并登记：deployments/<chainId>/LabToken.json + 源码指纹（沿用 P04 的 DeploymentRecorder 做法）。
/// admin 外置（CONTRACT_ADMIN），初始铸造只在部署者自己持 MINTER_ROLE 时执行——
/// admin 外置给多签后，增发必须由多签另行发起，部署脚本不越权。
contract Deploy is Script {
    function run() external returns (LabToken deployed) {
        uint256 cap = vm.envOr("LAB_CAP", uint256(1_000_000e18));
        uint256 initialMint = vm.envOr("LAB_INITIAL_MINT", uint256(100_000e18));
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (pk == 0) {
            vm.startBroadcast();
        } else {
            vm.startBroadcast(pk);
        }

        address deployer = pk == 0 ? msg.sender : vm.addr(pk);
        address admin = _admin(pk);
        deployed = new LabToken(admin, cap);

        bool minted = false;
        if (initialMint > 0 && deployed.hasRole(deployed.MINTER_ROLE(), deployer)) {
            address treasury = vm.envOr("LAB_TREASURY", deployer);
            deployed.mint(treasury, initialMint);
            minted = true;
        }
        vm.stopBroadcast();

        string memory record = _record(deployed, cap, initialMint, minted, pk, admin, deployer);
        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(record, string.concat(dir, "/LabToken.json"));
        vm.writeJson(record, "deployments/latest.json");

        console.log("LabToken deployed");
        console.log("  chainId     ", vm.toString(block.chainid));
        console.log("  address     ", vm.toString(address(deployed)));
        console.log("  admin       ", vm.toString(admin));
        console.log("  cap         ", vm.toString(cap));
        console.log("  initialMint ", minted ? vm.toString(initialMint) : "skipped (admin externalized)");
        console.log("  bytecodeHash", vm.toString(keccak256(address(deployed).code)));
        console.log("  record      ", string.concat(dir, "/LabToken.json"));
    }

    function _admin(uint256 pk) internal returns (address) {
        address configured = vm.envOr("CONTRACT_ADMIN", address(0));
        if (configured != address(0)) return configured;
        return pk == 0 ? msg.sender : vm.addr(pk);
    }

    function _record(
        LabToken t,
        uint256 cap,
        uint256 initialMint,
        bool minted,
        uint256 pk,
        address admin,
        address deployer
    ) internal returns (string memory) {
        string memory obj = vm.serializeString("record", "contract", "LabToken");
        obj = vm.serializeAddress("record", "address", address(t));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "deployer", deployer);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeUint("record", "cap", cap);
        obj = vm.serializeUint("record", "initialMint", minted ? initialMint : 0);
        obj = vm.serializeString("record", "version", t.VERSION());
        obj = vm.serializeBytes32("record", "deployedBytecodeHash", keccak256(address(t).code));
        // 编译参数必须随指纹一起记：换 evmVersion 重编指纹就变（B04 的 PUSH0 教训）
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));
        obj = vm.serializeString("record", "rpcUrl", vm.envOr("RPC_URL", string("")));
        obj = vm.serializeBool("record", "verifiableOnExplorer", vm.envOr("EXPLORER_VERIFY", false));
        return obj;
    }
}
