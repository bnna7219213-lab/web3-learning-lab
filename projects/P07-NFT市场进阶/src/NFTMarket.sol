// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice NFT 市场：托管挂单（list/cancel/buy）+ EIP-712 签名订单（链下撮合原语）两条路径。
///         成交时按 ERC2981 先付版税再付卖家；721 与 1155 统一按 Listing 处理（721 的 amount 恒 1）。
/// @dev 合规开关：tradingEnabled 默认 **false**——二级市场入口默认关闭，
///      运营方显式开启后才可挂单/成交（验收门禁）。开关只影响入口，不影响已托管资产的取回（cancel 不受开关限制）。
contract NFTMarket is Ownable, ReentrancyGuard, IERC721Receiver, IERC1155Receiver {
    using Address for address payable;

    struct Listing {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 amount; // ERC721 恒 1
        uint256 price;
        bool active;
    }

    struct SellOrder {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 amount;
        uint256 price;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "SellOrder(address seller,address nft,uint256 tokenId,uint256 amount,uint256 price,uint256 nonce,uint256 deadline)"
    );
    bytes4 private constant _ERC721_ID = 0x80ac58cd;
    bytes4 private constant _ERC1155_ID = 0xd9b67a26;

    uint256 public listingCount;
    mapping(uint256 => Listing) public listings;
    mapping(address => uint256) public orderNonces;
    bool public tradingEnabled;

    event TradingEnabled(bool on);
    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 amount,
        uint256 price
    );
    event Cancelled(uint256 indexed listingId);
    event Sold(uint256 indexed listingId, address indexed buyer, uint256 price, uint256 royaltyPaid);
    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed seller,
        address indexed buyer,
        address nft,
        uint256 tokenId,
        uint256 amount,
        uint256 price
    );

    error TradingDisabled();
    error NotSeller(uint256 listingId, address caller);
    error InactiveListing(uint256 listingId);
    error WrongPayment(uint256 sent, uint256 price);
    error ZeroPrice();
    error ZeroAmount();
    error BadAmountFor721(uint256 amount);
    error UnsupportedNft(address nft);
    error BadSignature(address recovered, address seller);
    error OrderExpired(uint256 deadline);
    error BadNonce(uint256 got, uint256 expected);

    constructor(address admin) Ownable(admin) {}

    // ---------- 合规开关 ----------

    function setTradingEnabled(bool on) external onlyOwner {
        tradingEnabled = on;
        emit TradingEnabled(on);
    }

    // ---------- 托管挂单 ----------

    function list(address nft, uint256 tokenId, uint256 amount, uint256 price)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (!tradingEnabled) revert TradingDisabled();
        if (price == 0) revert ZeroPrice();
        if (amount == 0) revert ZeroAmount();
        bool is721 = _is721(nft);
        if (is721 && amount != 1) revert BadAmountFor721(amount);

        id = listingCount++;
        listings[id] =
            Listing({seller: msg.sender, nft: nft, tokenId: tokenId, amount: amount, price: price, active: true});
        emit Listed(id, msg.sender, nft, tokenId, amount, price);

        // 托管：NFT 进市场合约，成交前卖家拿不回（cancel 除外）
        if (is721) {
            IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);
        } else {
            IERC1155(nft).safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        }
    }

    /// @dev cancel 不受 tradingEnabled 限制：开关关闭时卖家仍须能取回自己的资产。
    function cancel(uint256 id) external nonReentrant {
        Listing storage l = listings[id];
        if (!l.active) revert InactiveListing(id);
        if (l.seller != msg.sender) revert NotSeller(id, msg.sender);
        l.active = false;
        emit Cancelled(id);
        _sendNft(l.nft, l.seller, l.tokenId, l.amount);
    }

    function buy(uint256 id) external payable nonReentrant {
        if (!tradingEnabled) revert TradingDisabled();
        Listing storage l = listings[id];
        if (!l.active) revert InactiveListing(id);
        if (msg.value != l.price) revert WrongPayment(msg.value, l.price);

        l.active = false; // effects 先于一切外部调用
        (address royaltyReceiver, uint256 royalty) = _royalty(l.nft, l.tokenId, l.price);
        emit Sold(id, msg.sender, l.price, royalty);

        if (royalty > 0 && royaltyReceiver != address(0)) {
            payable(royaltyReceiver).sendValue(royalty);
        }
        payable(l.seller).sendValue(l.price - royalty);
        _sendNft(l.nft, msg.sender, l.tokenId, l.amount);
    }

    // ---------- 签名订单（链下撮合原语：NFT 不托管，签名即卖单） ----------

    function fillOrder(SellOrder calldata o, bytes calldata sig) external payable nonReentrant {
        if (!tradingEnabled) revert TradingDisabled();
        if (block.timestamp > o.deadline) revert OrderExpired(o.deadline);
        if (o.nonce != orderNonces[o.seller]) revert BadNonce(o.nonce, orderNonces[o.seller]);
        if (o.price == 0) revert ZeroPrice();
        if (o.amount == 0) revert ZeroAmount();
        if (msg.value != o.price) revert WrongPayment(msg.value, o.price);

        bytes32 digest = hashOrder(o);
        address recovered = ECDSA.recover(digest, sig);
        if (recovered != o.seller) revert BadSignature(recovered, o.seller);
        orderNonces[o.seller] = o.nonce + 1; // 单次有效：重放必失败

        (address royaltyReceiver, uint256 royalty) = _royalty(o.nft, o.tokenId, o.price);
        emit OrderFilled(digest, o.seller, msg.sender, o.nft, o.tokenId, o.amount, o.price);

        if (royalty > 0 && royaltyReceiver != address(0)) {
            payable(royaltyReceiver).sendValue(royalty);
        }
        payable(o.seller).sendValue(o.price - royalty);
        if (_is721(o.nft)) {
            IERC721(o.nft).safeTransferFrom(o.seller, msg.sender, o.tokenId);
        } else {
            IERC1155(o.nft).safeTransferFrom(o.seller, msg.sender, o.tokenId, o.amount, "");
        }
    }

    // ---------- 视图 ----------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NFTMarket")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function hashOrder(SellOrder calldata o) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(ORDER_TYPEHASH, o.seller, o.nft, o.tokenId, o.amount, o.price, o.nonce, o.deadline));
        return MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR(), structHash);
    }

    // ---------- 托管接收钩子：safeTransferFrom 要求接收方显式接受 ----------

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId || interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == 0x01ffc9a7;
    }

    // ---------- 内部 ----------

    function _is721(address nft) internal view returns (bool) {
        if (IERC165(nft).supportsInterface(_ERC721_ID)) return true;
        if (IERC165(nft).supportsInterface(_ERC1155_ID)) return false;
        revert UnsupportedNft(nft);
    }

    function _sendNft(address nft, address to, uint256 tokenId, uint256 amount) internal {
        if (_is721(nft)) {
            IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        } else {
            IERC1155(nft).safeTransferFrom(address(this), to, tokenId, amount, "");
        }
    }

    /// @dev ERC2981 是"建议"不是"强制"：不实现该接口的 NFT 版税为 0（局限见 docs）。
    function _royalty(address nft, uint256 tokenId, uint256 price) internal view returns (address, uint256) {
        try IERC2981(nft).royaltyInfo(tokenId, price) returns (address receiver, uint256 amount) {
            if (amount > price) return (address(0), 0); // 防御：版税超过成交价时不付（异常 NFT）
            return (receiver, amount);
        } catch {
            return (address(0), 0);
        }
    }
}
