// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Burnable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice 学习用 NFT（零价值记账凭证）：ERC721 + 元数据 URI + ERC2981 版税 + EIP-4907 租期。
/// @dev EIP-4907 的 owner/user 分离：owner 是产权，user 是限期使用权；
///      转让（含 burn）自动清空 user——产权变动不应继承旧租约。
contract LabNFT is ERC721, ERC721Burnable, ERC721URIStorage, ERC2981, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes4 private constant _IERC4907_ID = 0xad092b5c;

    uint256 public nextId;
    mapping(uint256 => address) private _users;
    mapping(uint256 => uint64) private _expires;

    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    error NotAuthorizedForToken(uint256 tokenId, address caller);

    constructor(address admin, string memory name_, string memory symbol_, address royaltyReceiver, uint96 royaltyBps)
        ERC721(name_, symbol_)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    function mint(address to, string calldata uri) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        id = nextId++;
        _safeMint(to, id);
        _setTokenURI(id, uri);
    }

    // ---------- EIP-4907 ----------

    function setUser(uint256 tokenId, address user, uint64 expires) external {
        address owner = ownerOf(tokenId);
        if (!_isAuthorized(owner, msg.sender, tokenId)) revert NotAuthorizedForToken(tokenId, msg.sender);
        _users[tokenId] = user;
        _expires[tokenId] = expires;
        emit UpdateUser(tokenId, user, expires);
    }

    function userOf(uint256 tokenId) external view returns (address) {
        if (_expires[tokenId] >= block.timestamp) return _users[tokenId];
        return address(0); // 到期即失效：不需要任何人来"收回"权限
    }

    function userExpires(uint256 tokenId) external view returns (uint64) {
        return _expires[tokenId];
    }

    // ---------- overrides ----------

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            // 转让/burn 清空租约：新 owner 不应被旧 user 占用
            delete _users[tokenId];
            delete _expires[tokenId];
            emit UpdateUser(tokenId, address(0), 0);
        }
        return from;
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721URIStorage, ERC2981, AccessControl)
        returns (bool)
    {
        return interfaceId == _IERC4907_ID || super.supportsInterface(interfaceId);
    }
}
