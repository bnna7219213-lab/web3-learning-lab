// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Counter} from "../src/Counter.sol";

/// 部署并登记：deployments/<chainId>/Counter.json + 打印可核对的源码指纹。
/// 为什么自己写登记（DeploymentRecorder）：B04 的联盟链没有 Etherscan 可 verify，
/// 客户与审计只能靠「地址 + deployedBytecodeHash + 构造参数」自证跑的是哪份代码。
contract Deploy is Script {
    function run() external returns (Counter deployed) {
        uint256 initial = vm.envOr("COUNTER_INITIAL", uint256(7));
        // forge-std 的 startBroadcast 只有 ()/(address)/(uint256) 三种重载，私钥按 uint256 传
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));

        if (pk == 0) {
            vm.startBroadcast();          // 用 forge 默认账户（anvil 场景）
        } else {
            vm.startBroadcast(pk);        // 用 .env 里的部署账户（sepolia / consortium 场景）
        }

        address admin = _admin(pk);
        deployed = new Counter(initial, admin);
        vm.stopBroadcast();

        string memory record = _record(deployed, initial, pk, admin);
        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(record, string.concat(dir, "/Counter.json"));
        vm.writeJson(record, "deployments/latest.json");

        console.log("Counter deployed");
        console.log("  chainId   ", vm.toString(block.chainid));
        console.log("  address   ", vm.toString(address(deployed)));
        console.log("  deployer  ", vm.toString(pk == 0 ? msg.sender : vm.addr(pk)));
        console.log("  bytecodeHash", vm.toString(keccak256(_code(deployed))));
        console.log("  record    ", string.concat(dir, "/Counter.json"));
    }

    function _code(Counter c) internal view returns (bytes memory) {
        return address(c).code;
    }

    /// 管理者：优先用 CONTRACT_ADMIN（联盟网里填客户多签），否则回落到部署账户
    function _admin(uint256 pk) internal returns (address) {
        address configured = vm.envOr("CONTRACT_ADMIN", address(0));
        if (configured != address(0)) return configured;
        return pk == 0 ? msg.sender : vm.addr(pk);
    }

    // 不能标 view：vm.serializeXxx / vm.envOr 是对 Vm 外部合约的调用，Solidity 视为可能改状态
    function _record(Counter c, uint256 initial, uint256 pk, address admin) internal returns (string memory) {
        // 真正的创建者是广播用的 EOA，不是脚本调用者 msg.sender（后者是 forge 默认 sender）
        address deployer = pk == 0 ? msg.sender : vm.addr(pk);

        string memory obj = vm.serializeString("record", "contract", "Counter");
        obj = vm.serializeAddress("record", "address", address(c));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "deployer", deployer);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeString("record", "version", c.VERSION());
        obj = vm.serializeUint("record", "constructorInitial", initial);
        obj = vm.serializeBytes32("record", "deployedBytecodeHash", keccak256(_code(c)));
        // 编译设置必须一起记：deployedBytecodeHash 只有在**同一套编译参数**下才可复现。
        // B04 实测：联盟网 genesis 只到 London，用 evm_version=cancun 编出来的字节码含 PUSH0，
        // 部署会 status=0；换成 london 后同一份源码得到完全不同的字节码。客户若不知道当时用的
        // 是哪个 profile / evmVersion，重编译出来的指纹必然对不上，指纹自证当场失效。
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("unknown")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));
        obj = vm.serializeString("record", "rpcUrl", vm.envOr("RPC_URL", string("")));
        obj = vm.serializeString("record", "explorerUrl", vm.envOr("EXPLORER_URL", string("")));
        obj = vm.serializeBool("record", "verifiableOnExplorer", vm.envOr("EXPLORER_VERIFY", false));
        return obj;
    }
}
