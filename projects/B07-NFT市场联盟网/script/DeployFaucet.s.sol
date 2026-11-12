// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LabFaucet} from "../src/LabFaucet.sol";

/// @notice 部署水龙头额度合约 LabFaucet（B03 × B07 预算治理衔接的链上地基）
/// @dev 联盟网注意（与 LabCredential 部署同款约束）：
///      - 必须 FOUNDRY_PROFILE=consortium（london 指令集），否则字节码含 PUSH0 → 进块但 status=0；
///      - 必须 --legacy --gas-price 0（零 gas 网络）+ 显式 --gas-limit（账户余额为 0 时
///        eth_estimateGas 会因余额不足直接失败，估算这一步过不去）。
///
///      部署后需要另外充值（fund()）：合约自己持币，发放才是链上转账。
contract DeployFaucet is Script {
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

        // 治理参数：额度/单次金额/冷却都是链上参数，admin 之后可改（事件留痕）
        uint256 cap = vm.envOr("FAUCET_DAILY_CAP", uint256(500 ether));
        uint256 amount = vm.envOr("FAUCET_AMOUNT_PER_CLAIM", uint256(10 ether));
        uint32 cooldown = uint32(vm.envOr("FAUCET_COOLDOWN_SECONDS", uint256(60)));

        LabFaucet faucet = new LabFaucet(admin, cap, amount, cooldown);
        vm.stopBroadcast();

        string memory obj = vm.serializeString("record", "project", "B07");
        obj = vm.serializeAddress("record", "faucet", address(faucet));
        obj = vm.serializeUint("record", "chainId", block.chainid);
        obj = vm.serializeAddress("record", "admin", admin);
        obj = vm.serializeUint("record", "dailyCap", cap);
        obj = vm.serializeUint("record", "amountPerClaim", amount);
        obj = vm.serializeUint("record", "cooldownSeconds", cooldown);
        obj = vm.serializeBytes32("record", "bytecodeHash", keccak256(address(faucet).code));
        obj = vm.serializeString("record", "foundryProfile", vm.envOr("FOUNDRY_PROFILE", string("default")));
        obj = vm.serializeString("record", "evmVersion", vm.envOr("EVM_VERSION_RECORD", string("cancun")));
        obj = vm.serializeString("record", "networkProfile", vm.envOr("NETWORK_PROFILE", string("unknown")));

        string memory dir = string.concat("deployments/", vm.toString(block.chainid));
        vm.createDir(dir, true);
        vm.writeJson(obj, string.concat(dir, "/B07Faucet.json"));
        vm.writeJson(obj, "deployments/faucet-latest.json");

        console.log("LabFaucet deployed");
        console.log("  faucet   ", vm.toString(address(faucet)));
        console.log("  admin    ", vm.toString(admin));
        console.log("  dailyCap ", vm.toString(cap / 1 ether), " B03");
        console.log("  perClaim ", vm.toString(amount / 1 ether), " B03");
        console.log("  cooldown ", vm.toString(cooldown), " s");
        console.log("  chainId  ", vm.toString(block.chainid));
    }
}
