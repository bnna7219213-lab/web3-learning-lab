// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LabNFT} from "../src/LabNFT.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract LabNFTTest is Test {
    LabNFT nft;
    address admin = makeAddr("admin");
    address royaltyReceiver = makeAddr("royalty");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address user = makeAddr("user");

    function setUp() public {
        nft = new LabNFT(admin, "LabNFT", "LNFT", royaltyReceiver, 500); // 5%
        vm.prank(admin);
        nft.mint(alice, "ipfs://bafyexample0");
    }

    function test_MintSetsUriAndDefaultRoyalty() public view {
        assertEq(nft.ownerOf(0), alice);
        assertEq(nft.tokenURI(0), "ipfs://bafyexample0");
        (address recv, uint256 amt) = nft.royaltyInfo(0, 1 ether);
        assertEq(recv, royaltyReceiver);
        assertEq(amt, 0.05 ether);
    }

    function test_MintRequiresRole() public {
        vm.prank(bob);
        vm.expectRevert();
        nft.mint(bob, "ipfs://x");
    }

    function test_Supports4907() public view {
        assertTrue(nft.supportsInterface(0xad092b5c));
        assertTrue(nft.supportsInterface(0x80ac58cd)); // 721
        assertTrue(nft.supportsInterface(0x2a55205a)); // 2981
    }

    // ---------- EIP-4907 ----------

    function test_OwnerSetsUserAndExpiry() public {
        uint64 expires = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        nft.setUser(0, user, expires);
        assertEq(nft.userOf(0), user);
        assertEq(nft.userExpires(0), expires);
    }

    function test_ApprovedOperatorCanSetUser() public {
        vm.prank(alice);
        nft.approve(bob, 0);
        vm.prank(bob);
        nft.setUser(0, user, uint64(block.timestamp + 1 hours));
        assertEq(nft.userOf(0), user);
    }

    function test_StrangerCannotSetUser() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LabNFT.NotAuthorizedForToken.selector, 0, bob));
        nft.setUser(0, user, uint64(block.timestamp + 1 hours));
    }

    function test_UserExpiresAutomatically() public {
        uint64 expires = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        nft.setUser(0, user, expires);
        vm.warp(expires); // 边界：expires 当刻仍有效
        assertEq(nft.userOf(0), user);
        vm.warp(expires + 1); // 过期：无需任何人操作，权限自动失效
        assertEq(nft.userOf(0), address(0));
        assertEq(nft.userExpires(0), expires); // 历史 expiry 仍可查
    }

    function test_TransferClearsUser() public {
        vm.prank(alice);
        nft.setUser(0, user, uint64(block.timestamp + 1 days));
        vm.prank(alice);
        nft.transferFrom(alice, bob, 0);
        assertEq(nft.userOf(0), address(0)); // 产权变动不继承旧租约
        assertEq(nft.userExpires(0), 0);
    }

    function test_BurnClearsUser() public {
        vm.prank(alice);
        nft.setUser(0, user, uint64(block.timestamp + 1 days));
        vm.prank(alice);
        nft.burn(0);
        // burn 后 token 不存在，userOf 仍应返回 0（存储已清）
        assertEq(nft.userOf(0), address(0));
    }

    function testFuzz_UserNeverValidPastExpiry(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 1, 365 days));
        elapsed = uint64(bound(elapsed, 0, 730 days));
        uint64 expires = uint64(block.timestamp) + ttl;
        vm.prank(alice);
        nft.setUser(0, user, expires);
        vm.warp(uint256(block.timestamp) + elapsed);
        if (block.timestamp > expires) {
            assertEq(nft.userOf(0), address(0));
        } else {
            assertEq(nft.userOf(0), user);
        }
    }
}
