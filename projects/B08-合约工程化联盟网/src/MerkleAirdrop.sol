// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MerkleAirdrop —— 合约端 Merkle proof 验证（P8-S5）
/// @notice 与 P01 链下实现（frontend/lib/merkle.js）**逐字对齐**的三件事：
///         1. 哈希：sha256（不是 keccak256）——P01 用 Node crypto.sha256
///         2. 前缀：叶子 `L|data`，内部节点 `N|leftHex+rightHex`（防二像攻击）
///         3. 位置：按叶子索引的二进制位决定左右（idx&1==1 → 兄弟在左），
///            与 P01 getProof 的 position 语义一一对应；奇数层复制末尾（P01 已知弱点，
///            两边同弱才算「互相验证」——索引哈希是生产改造方向，见 docs/04）
contract MerkleAirdrop {
    bytes32 public immutable root;

    mapping(bytes32 => bool) public claimedLeaf; // 防重领：以叶子哈希为键

    event Claimed(bytes32 indexed leafHash, address indexed to, string data);

    error InvalidProof();
    error AlreadyClaimed(bytes32 leaf);

    constructor(bytes32 root_) {
        root = root_;
    }

    /// @notice 叶子哈希：sha256("L|" + data)，与 P01 hashLeaf 完全一致
    function leafHash(string calldata data) public pure returns (bytes32) {
        return sha256(bytes(string.concat("L|", data)));
    }

    /// @notice 验证并登记领取
    /// @param data   原始单据文本（P01 批次里的第 index 条）
    /// @param proof  从叶子到根的兄弟节点序列（P01 getProof 原样导出）
    /// @param index  叶子在批次中的下标——位置由索引位推导，不随证明传入
    function claim(string calldata data, bytes32[] calldata proof, uint256 index) external {
        bytes32 leaf = leafHash(data);
        if (claimedLeaf[leaf]) revert AlreadyClaimed(leaf);
        if (!_verify(leaf, proof, index)) revert InvalidProof();

        claimedLeaf[leaf] = true;
        emit Claimed(leaf, msg.sender, data);
    }

    /// @notice 只验不领（对账/前端预检用）
    function verify(string calldata data, bytes32[] calldata proof, uint256 index) external view returns (bool) {
        return _verify(leafHash(data), proof, index);
    }

    function _verify(bytes32 leaf, bytes32[] calldata proof, uint256 index) internal view returns (bool) {
        bytes32 current = leaf;
        uint256 idx = index;
        for (uint256 i; i < proof.length; ++i) {
            // idx 的最低位 == 1 → 当前节点是右孩子（兄弟在左）；== 0 → 兄弟在右
            // 与 P01: isRight = i % 2 === 1 同构
            if (idx & 1 == 1) {
                current = sha256(bytes(string.concat("N|", _hex(proof[i]), _hex(current))));
            } else {
                current = sha256(bytes(string.concat("N|", _hex(current), _hex(proof[i]))));
            }
            idx >>= 1;
        }
        return current == root;
    }

    /// @dev bytes32 → 64 字符小写 hex（Node Buffer.toString("hex") 的等价物）
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
