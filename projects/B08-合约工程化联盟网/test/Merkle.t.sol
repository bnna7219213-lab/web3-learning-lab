// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {MerkleAirdrop} from "../src/MerkleAirdrop.sol";

/// @notice P8-S5：合约端 Merkle 验证 vs P01 链下实现的互相验证
/// @dev 真实向量来源：`node projects/P01-区块链认知工具箱基础/demos/merkle-proof.mjs`
///      （13 份批次，第 7 份出证包；root/leaf/proof 全部从 P01 导出，非本合约自产）
contract MerkleTest is Test {
    // ── P01 导出的真实向量（2026-11-13 导出，改 P01 算法必挂此测试）──────────
    bytes32 internal constant P01_ROOT = 0x9a70e0ab32d1a4e552a7dfbfd3eb016f769103d8226dd134125347ac6f9836d6;
    string internal constant P01_DATA_7 = unicode"发票 NO.2026-10-8 供应商B 金额 8000";
    bytes32 internal constant P01_LEAF_7 = 0xdcda5b0519f715fc6d27e3209350edcad7bbf30870a7674da693f07e8433be6a;

    // P01 出证包 proof[4]：position = left,left,left,right
    // 左位 → 兄弟在前（合约里 idx&1==1）；右位 → 兄弟在后（idx&1==0）
    bytes32 internal constant P01_PROOF_0 = 0x9a79fb16d2ea8351805d737ad7902940d31e30e99146fd001b5d6c524c54d4b5;
    bytes32 internal constant P01_PROOF_1 = 0xda2a85b859bdd1a038d59803b1b3d9874a8b33daa6db1b2ffcb9b3086dfcbc08;
    bytes32 internal constant P01_PROOF_2 = 0xc2031abf6f6acfa4a476943d131cb7672680beafc95b6c1bfdbe29ed91e79d35;
    bytes32 internal constant P01_PROOF_3 = 0x52bc1b92ea185958738eeb2e110c799de072f89db50487ec8785235a772d3c5e;

    MerkleAirdrop internal drop;
    address internal alice = makeAddr("alice");

    function setUp() public {
        drop = new MerkleAirdrop(P01_ROOT);
    }

    function _proof7() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](4);
        p[0] = P01_PROOF_0;
        p[1] = P01_PROOF_1;
        p[2] = P01_PROOF_2;
        p[3] = P01_PROOF_3;
    }

    // ── 互相验证①：P01 出证包在合约端 verify 通过 ────────────────────────────
    function test_p01VectorVerifiesOnchain() public view {
        assertEq(drop.leafHash(P01_DATA_7), P01_LEAF_7, unicode"叶子哈希与 P01 不一致（sha256+L| 前缀）");
        assertTrue(drop.verify(P01_DATA_7, _proof7(), 7), unicode"P01 证明在合约端被拒");
    }

    // ── 互相验证②：claim 成功 + 防重领 ───────────────────────────────────────
    function test_claimAndReplayRejected() public {
        vm.prank(alice);
        drop.claim(P01_DATA_7, _proof7(), 7);

        assertTrue(drop.claimedLeaf(P01_LEAF_7), unicode"领取后叶子应被标记");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MerkleAirdrop.AlreadyClaimed.selector, P01_LEAF_7));
        drop.claim(P01_DATA_7, _proof7(), 7);
    }

    // ── 负例1：篡改金额（P01 demo 的伪造实验）→ 合约端复算根不等 → 拒绝 ──────
    function test_forgedAmountRejected() public view {
        string memory forged = unicode"发票 NO.2026-10-8 供应商B 金额 999999";
        assertFalse(drop.verify(forged, _proof7(), 7), unicode"篡改金额必须被拒");
    }

    // ── 负例2：索引错位 → 左右顺序错 → 拒绝（证明 index 参与位置推导）─────────
    function test_wrongIndexRejected() public view {
        assertFalse(drop.verify(P01_DATA_7, _proof7(), 6), unicode"错误索引必须被拒");
        assertFalse(drop.verify(P01_DATA_7, _proof7(), 1), unicode"错误索引必须被拒");
    }

    // ── 负例3：篡改证明中的一个兄弟节点 → 拒绝 ────────────────────────────────
    function test_tamperedProofRejected() public view {
        bytes32[] memory p = _proof7();
        p[2] = bytes32(uint256(1));
        assertFalse(drop.verify(P01_DATA_7, p, 7), unicode"篡改证明必须被拒");
    }

    // ── 互相验证③：在 Solidity 里按 P01 算法重build整棵树，root 必须逐字相等 ──
    function test_rebuildTreeMatchesP01Root() public view {
        string[13] memory batch = _p01Batch();
        bytes32[] memory leaves13 = new bytes32[](13);
        for (uint256 i; i < 13; ++i) {
            leaves13[i] = sha256(bytes(string.concat("L|", batch[i])));
        }
        bytes32 computed = _rootFromLeaves(leaves13);
        assertEq(computed, P01_ROOT, unicode"Solidity 重build 的根与 P01 不一致");
        console.log(unicode"双向对账：链下 root == 链上重算 root");
    }

    // ── 互相验证④：P01 已知弱点（3 份 vs 3+末尾重复同根）在合约端同样复现 ────
    function test_p01KnownWeaknessReproduced() public {
        bytes32[] memory three = new bytes32[](3);
        three[0] = sha256(bytes(string.concat("L|", "A")));
        three[1] = sha256(bytes(string.concat("L|", "B")));
        three[2] = sha256(bytes(string.concat("L|", "C")));
        bytes32 root3 = _rootFromLeaves(three);

        bytes32[] memory four = new bytes32[](4);
        four[0] = three[0];
        four[1] = three[1];
        four[2] = three[2];
        four[3] = three[2]; // 复制末尾（Bitcoin 早期做法）
        bytes32 root4 = _rootFromLeaves(four);

        assertEq(root3, root4, unicode"P01 记录的等价树弱点应在合约端同样复现");
        // 结论写入 docs/04：两边同弱才叫互相验证；生产改索引哈希/MMR
    }

    // ── helpers：复刻 P01 buildMerkleTree（奇数复制末尾）──────────────────────
    function _rootFromLeaves(bytes32[] memory cur) internal pure returns (bytes32) {
        while (cur.length > 1) {
            bytes32[] memory next = new bytes32[](cur.length / 2 + (cur.length % 2));
            for (uint256 i; i < next.length; ++i) {
                bytes32 left = cur[i * 2];
                bytes32 right = (i * 2 + 1 < cur.length) ? cur[i * 2 + 1] : left; // 奇数复制末尾
                next[i] = sha256(bytes(string.concat("N|", _hex(left), _hex(right))));
            }
            cur = next;
        }
        return cur[0];
    }

    function _p01Batch() internal pure returns (string[13] memory batch) {
        string[3] memory vendors = [unicode"供应商A", unicode"供应商B", unicode"供应商C"];
        for (uint256 i; i < 13; ++i) {
            // P01: `发票 NO.2026-10-${i+1} 供应商${"ABC"[i%3]} 金额 ${1000*(i+1)}`
            batch[i] = string.concat(
                unicode"发票 NO.2026-10-",
                vm.toString(i + 1),
                " ",
                vendors[i % 3],
                " ",
                unicode"金额 ",
                vm.toString(1000 * (i + 1))
            );
        }
    }

    function _hex(bytes32 b) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            out[i * 2] = alphabet[uint8(b[i]) >> 4];
            out[i * 2 + 1] = alphabet[uint8(b[i]) & 0x0f];
        }
        return string(out);
    }
}
