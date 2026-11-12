// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155URIStorage} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice 学习用多Edition凭证（ERC1155）：同一 tokenId 可有多份，与 721 的"唯一性"对照。
/// @dev 市场按 amount 托管与成交；版税按整笔成交价计（ERC2981 不感知份数）。
contract LabEditions is ERC1155, ERC1155URIStorage, ERC2981, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address admin, address royaltyReceiver, uint96 royaltyBps) ERC1155("") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    function mint(address to, uint256 id, uint256 amount, string calldata uri) external onlyRole(MINTER_ROLE) {
        _mint(to, id, amount, "");
        _setURI(id, uri);
    }

    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts, string calldata uri)
        external
        onlyRole(MINTER_ROLE)
    {
        _mintBatch(to, ids, amounts, "");
        for (uint256 i = 0; i < ids.length; i++) {
            _setURI(ids[i], uri);
        }
    }

    function uri(uint256 tokenId) public view override(ERC1155, ERC1155URIStorage) returns (string memory) {
        return super.uri(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, ERC2981, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
