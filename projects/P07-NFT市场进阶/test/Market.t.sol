// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabNFT} from "../src/LabNFT.sol";
import {LabEditions} from "../src/LabEditions.sol";
import {NFTMarket} from "../src/NFTMarket.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// 重入攻击者：收到 NFT 时立刻再买同一单（应被 ReentrancyGuard 拒）
contract ReentrantBuyer is IERC721Receiver {
    NFTMarket market;
    uint256 target;

    constructor(NFTMarket m) {
        market = m;
    }

    function attack(uint256 id) external payable {
        target = id;
        market.buy{value: msg.value}(id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        market.buy{value: address(this).balance}(target); // 重入
        return IERC721Receiver.onERC721Received.selector;
    }
    receive() external payable {}
}

contract DummyNo165 {
    function supportsInterface(bytes4) external pure returns (bool) {
        return false;
    }
}

/// 异常 NFT：版税报价超过成交价——市场应防御为 0 而非照付
contract EvilRoyaltyNFT is ERC721 {
    constructor() ERC721("Evil", "EVIL") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function royaltyInfo(uint256, uint256 salePrice) external pure returns (address, uint256) {
        return (address(0x1234), salePrice * 2);
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0x2a55205a || super.supportsInterface(id);
    }
}

contract MarketTest is Test {
    LabNFT nft;
    LabEditions editions;
    NFTMarket market;
    address royaltyReceiver = makeAddr("royalty");
    address seller = makeAddr("seller");
    uint256 sellerPk = 0x5E11E2;
    address buyer = makeAddr("buyer");

    function setUp() public {
        seller = vm.addr(sellerPk);
        nft = new LabNFT(address(this), "LabNFT", "LNFT", royaltyReceiver, 500);
        editions = new LabEditions(address(this), royaltyReceiver, 500);
        market = new NFTMarket(address(this));
        nft.mint(seller, "ipfs://bafyexample0");
        editions.mint(seller, 1, 10, "ipfs://bafyexample1");
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        vm.prank(seller);
        editions.setApprovalForAll(address(market), true);
    }

    function _enable() internal {
        market.setTradingEnabled(true);
    }

    function _list721(uint256 price) internal returns (uint256 id) {
        vm.prank(seller);
        id = market.list(address(nft), 0, 1, price);
    }

    // ---------- 合规开关 ----------

    function test_TradingDisabledByDefault() public {
        assertFalse(market.tradingEnabled());
        vm.prank(seller);
        vm.expectRevert(NFTMarket.TradingDisabled.selector);
        market.list(address(nft), 0, 1, 1 ether);
        vm.expectRevert(NFTMarket.TradingDisabled.selector);
        market.buy{value: 1 ether}(0);
    }

    function test_OnlyOwnerCanEnable() public {
        vm.prank(buyer);
        vm.expectRevert();
        market.setTradingEnabled(true);
    }

    function test_CancelStillWorksWhenDisabled() public {
        _enable();
        uint256 id = _list721(1 ether);
        market.setTradingEnabled(false); // 关闭入口后卖家仍须能取回资产
        vm.prank(seller);
        market.cancel(id);
        assertEq(nft.ownerOf(0), seller);
    }

    // ---------- 721 托管全流程 ----------

    function test_ListEscrowsNft() public {
        _enable();
        uint256 id = _list721(1 ether);
        assertEq(nft.ownerOf(0), address(market));
        (address s, address n, uint256 t, uint256 a, uint256 p, bool active) = market.listings(id);
        assertEq(s, seller);
        assertEq(n, address(nft));
        assertEq(t, 0);
        assertEq(a, 1);
        assertEq(p, 1 ether);
        assertTrue(active);
    }

    function test_BuyPaysRoyaltyThenSeller() public {
        _enable();
        uint256 id = _list721(1 ether);
        uint256 sellerBefore = seller.balance;
        uint256 royaltyBefore = royaltyReceiver.balance;
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id);
        assertEq(nft.ownerOf(0), buyer);
        assertEq(royaltyReceiver.balance - royaltyBefore, 0.05 ether);
        assertEq(seller.balance - sellerBefore, 0.95 ether);
        (,,,,, bool active) = market.listings(id);
        assertFalse(active);
    }

    function test_WrongPaymentReverts() public {
        _enable();
        uint256 id = _list721(1 ether);
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.WrongPayment.selector, 0.9 ether, 1 ether));
        market.buy{value: 0.9 ether}(id);
    }

    function test_CancelOnlySellerAndOnce() public {
        _enable();
        uint256 id = _list721(1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.NotSeller.selector, id, buyer));
        market.cancel(id);
        vm.prank(seller);
        market.cancel(id);
        assertEq(nft.ownerOf(0), seller);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.InactiveListing.selector, id));
        market.cancel(id);
    }

    function test_BuyInactiveReverts() public {
        _enable();
        uint256 id = _list721(1 ether);
        vm.prank(seller);
        market.cancel(id);
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.InactiveListing.selector, id));
        market.buy{value: 1 ether}(id);
    }

    function test_BadAmountFor721() public {
        _enable();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.BadAmountFor721.selector, 2));
        market.list(address(nft), 0, 2, 1 ether);
    }

    function test_UnsupportedNftReverts() public {
        _enable();
        DummyNo165 dummy = new DummyNo165();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.UnsupportedNft.selector, address(dummy)));
        market.list(address(dummy), 0, 1, 1 ether);
    }

    // ---------- 1155 ----------

    function test_EditionsMintBatchAndUri() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = 2;
        ids[1] = 3;
        uint256[] memory amts = new uint256[](2);
        amts[0] = 5;
        amts[1] = 7;
        editions.mintBatch(seller, ids, amts, "ipfs://bafybatch");
        assertEq(editions.balanceOf(seller, 2), 5);
        assertEq(editions.balanceOf(seller, 3), 7);
        assertEq(editions.uri(2), "ipfs://bafybatch");
        assertEq(editions.uri(3), "ipfs://bafybatch");
    }

    function test_List1155AndBuyAmount() public {
        _enable();
        vm.prank(seller);
        uint256 id = market.list(address(editions), 1, 4, 2 ether);
        assertEq(editions.balanceOf(address(market), 1), 4);
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        market.buy{value: 2 ether}(id);
        assertEq(editions.balanceOf(buyer, 1), 4);
        assertEq(editions.balanceOf(seller, 1), 6);
        assertEq(royaltyReceiver.balance, 0.1 ether);
    }

    // ---------- 签名订单 ----------

    function _order(uint256 price, uint256 nonce, uint256 deadline)
        internal
        view
        returns (NFTMarket.SellOrder memory)
    {
        return NFTMarket.SellOrder({
            seller: seller, nft: address(nft), tokenId: 0, amount: 1, price: price, nonce: nonce, deadline: deadline
        });
    }

    function _sign(NFTMarket.SellOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerPk, market.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function test_FillSignedOrderNoEscrow() public {
        _enable();
        NFTMarket.SellOrder memory o = _order(1 ether, 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(o); // 先签：_sign 内含外部调用，会消耗 prank
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(o, sig);
        assertEq(nft.ownerOf(0), buyer); // 直接从卖家转给买家，无托管
        assertEq(seller.balance, 0.95 ether);
        assertEq(market.orderNonces(seller), 1);
    }

    function test_SignedOrderReplayReverts() public {
        _enable();
        NFTMarket.SellOrder memory o = _order(1 ether, 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(o);
        vm.deal(buyer, 5 ether);
        vm.startPrank(buyer);
        market.fillOrder{value: 1 ether}(o, sig);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.BadNonce.selector, 0, 1));
        market.fillOrder{value: 1 ether}(o, sig);
        vm.stopPrank();
    }

    function test_SignedOrderExpiredReverts() public {
        _enable();
        NFTMarket.SellOrder memory o = _order(1 ether, 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(o);
        vm.warp(block.timestamp + 2 hours);
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(NFTMarket.OrderExpired.selector, o.deadline));
        market.fillOrder{value: 1 ether}(o, sig);
    }

    function test_SignedOrderTamperedPriceReverts() public {
        _enable();
        NFTMarket.SellOrder memory o = _order(1 ether, 0, block.timestamp + 1 hours);
        bytes memory sig = _sign(o);
        o.price = 0.1 ether; // 中继改价
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectPartialRevert(NFTMarket.BadSignature.selector);
        market.fillOrder{value: 0.1 ether}(o, sig);
    }

    function test_SignedOrderWrongSignerReverts() public {
        _enable();
        NFTMarket.SellOrder memory o = _order(1 ether, 0, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, market.hashOrder(o));
        vm.deal(buyer, 5 ether);
        vm.prank(buyer);
        vm.expectPartialRevert(NFTMarket.BadSignature.selector);
        market.fillOrder{value: 1 ether}(o, abi.encodePacked(r, s, v));
    }

    // ---------- 重入 ----------

    function test_ReentrantBuyBlocked() public {
        _enable();
        uint256 id = _list721(1 ether);
        ReentrantBuyer attacker = new ReentrantBuyer(market);
        vm.deal(address(attacker), 3 ether);
        vm.expectRevert(); // 内层重入被 guard 拒 → 整笔回滚
        attacker.attack{value: 1 ether}(id);
        assertEq(nft.ownerOf(0), address(market)); // 托管未被破坏
    }

    // ---------- fuzz ----------

    function test_ZeroAmountReverts() public {
        _enable();
        vm.prank(seller);
        vm.expectRevert(NFTMarket.ZeroAmount.selector);
        market.list(address(editions), 1, 0, 1 ether);
    }

    function test_BatchReceiveHook() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amts = new uint256[](1);
        amts[0] = 2;
        vm.prank(seller);
        editions.safeBatchTransferFrom(seller, address(market), ids, amts, "");
        assertEq(editions.balanceOf(address(market), 1), 2);
        assertTrue(market.supportsInterface(type(IERC721Receiver).interfaceId));
    }

    function test_RoyaltyOverPriceDefended() public {
        _enable();
        EvilRoyaltyNFT evil = new EvilRoyaltyNFT();
        evil.mint(seller, 0);
        vm.prank(seller);
        evil.setApprovalForAll(address(market), true);
        vm.prank(seller);
        uint256 id = market.list(address(evil), 0, 1, 1 ether);
        uint256 sb = seller.balance;
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id);
        assertEq(seller.balance - sb, 1 ether); // 异常版税被防御为 0，卖家拿全额
        assertEq(address(0x1234).balance, 0);
    }

    function testFuzz_RoyaltySplitConservesPrice(uint256 price) public {
        price = bound(price, 1, 1000 ether);
        _enable();
        uint256 id = _list721(price);
        uint256 sb = seller.balance;
        uint256 rb = royaltyReceiver.balance;
        vm.deal(buyer, price);
        vm.prank(buyer);
        market.buy{value: price}(id);
        assertEq((seller.balance - sb) + (royaltyReceiver.balance - rb), price);
        assertEq(royaltyReceiver.balance - rb, price * 500 / 10000);
    }

    function testFuzz_1155AmountConserved(uint256 amount) public {
        amount = bound(amount, 1, 10);
        _enable();
        vm.prank(seller);
        uint256 id = market.list(address(editions), 1, amount, 1 ether);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        market.buy{value: 1 ether}(id);
        assertEq(editions.balanceOf(buyer, 1) + editions.balanceOf(seller, 1), 10);
    }
}
