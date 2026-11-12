// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabNFT} from "../src/LabNFT.sol";
import {NFTMarket} from "../src/NFTMarket.sol";

/// 托管守恒不变式：市场持有的 721 数量 == 活跃挂单数；
/// 任何 list/cancel/buy 序列都不允许"单在币不在"或"币在单不在"。
contract MarketHandler is Test {
    LabNFT public nft;
    NFTMarket public market;
    address public seller;
    uint256 public constant POOL = 12;
    uint256 public listed; // 已挂出的 tokenId 计数（顺序取用）

    constructor(LabNFT n, NFTMarket m, address s) {
        nft = n;
        market = m;
        seller = s;
    }

    function list(uint256 price) external {
        if (listed >= POOL) return;
        price = bound(price, 1, 10 ether);
        uint256 id = listed++;
        vm.prank(seller);
        market.list(address(nft), id, 1, price);
    }

    function cancel(uint256 seed) external {
        uint256 count = market.listingCount();
        if (count == 0) return;
        uint256 id = seed % count;
        (address s,,,,, bool active) = market.listings(id);
        if (!active) return;
        vm.prank(s);
        market.cancel(id);
    }

    function buy(uint256 seed, uint256 price) external {
        uint256 count = market.listingCount();
        if (count == 0) return;
        uint256 id = seed % count;
        (, address nft_, uint256 tokenId,, uint256 p, bool active) = market.listings(id);
        if (!active) return;
        address buyer = address(uint160(0xB000 + (seed % 3)));
        vm.deal(buyer, p);
        vm.prank(buyer);
        market.buy{value: p}(id);
    }
}

contract InvariantTest is Test {
    LabNFT nft;
    NFTMarket market;
    MarketHandler handler;
    address seller = makeAddr("seller");

    function setUp() public {
        nft = new LabNFT(address(this), "LabNFT", "LNFT", makeAddr("r"), 500);
        market = new NFTMarket(address(this));
        market.setTradingEnabled(true);
        for (uint256 i = 0; i < 12; i++) {
            nft.mint(seller, "ipfs://bafypool");
        }
        vm.prank(seller);
        nft.setApprovalForAll(address(market), true);
        handler = new MarketHandler(nft, market, seller);
        targetContract(address(handler));
    }

    function invariant_EscrowMatchesActiveListings() public view {
        uint256 active;
        uint256 count = market.listingCount();
        for (uint256 i = 0; i < count; i++) {
            (,,,,, bool a) = market.listings(i);
            if (a) active++;
        }
        assertEq(nft.balanceOf(address(market)), active);
    }

    function invariant_SupplyUnchangedByMarket() public view {
        assertEq(nft.nextId(), 12); // 市场只流转，不铸造
    }
}
