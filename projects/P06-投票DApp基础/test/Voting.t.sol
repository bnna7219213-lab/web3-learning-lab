// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Voting} from "../src/Voting.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract VotingTest is Test {
    Voting voting;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        voting = new Voting(admin);
    }

    function _create(uint256 duration) internal returns (uint256 id) {
        vm.prank(admin);
        id = voting.createProposal("Should we adopt the lab token?", duration);
    }

    // ---------- 建提案 ----------

    function test_CreateEmitsEventAndStores() public {
        vm.expectEmit(true, false, false, true);
        emit Voting.ProposalCreated(0, "Should we adopt the lab token?", block.timestamp + 1 days, admin);
        uint256 id = _create(1 days);
        assertEq(id, 0);
        assertEq(voting.proposalCount(), 1);
        (string memory title, uint256 deadline, uint256 f, uint256 a) = voting.getProposal(0);
        assertEq(title, "Should we adopt the lab token?");
        assertEq(deadline, block.timestamp + 1 days);
        assertEq(f, 0);
        assertEq(a, 0);
    }

    function test_OnlyOwnerCanCreate() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        voting.createProposal("x", 1 days);
    }

    function test_AdminIsExternalized() public view {
        assertEq(voting.owner(), admin);
    }

    function test_EmptyTitleAndZeroDurationRevert() public {
        vm.startPrank(admin);
        vm.expectRevert(Voting.EmptyTitle.selector);
        voting.createProposal("", 1 days);
        vm.expectRevert(Voting.ZeroDuration.selector);
        voting.createProposal("x", 0);
        vm.stopPrank();
    }

    // ---------- 投票 ----------

    function test_VoteYesNoAndTally() public {
        uint256 id = _create(1 days);
        vm.prank(alice);
        voting.vote(id, true);
        vm.prank(bob);
        voting.vote(id, false);
        (uint256 f, uint256 a) = voting.tally(id);
        assertEq(f, 1);
        assertEq(a, 1);
        assertTrue(voting.hasVoted(id, alice));
        assertTrue(voting.hasVoted(id, bob));
    }

    function test_VoteEmitsEvent() public {
        uint256 id = _create(1 days);
        vm.expectEmit(true, true, false, true);
        emit Voting.Voted(id, alice, true);
        vm.prank(alice);
        voting.vote(id, true);
    }

    function test_DoubleVoteReverts() public {
        uint256 id = _create(1 days);
        vm.startPrank(alice);
        voting.vote(id, true);
        vm.expectRevert(abi.encodeWithSelector(Voting.AlreadyVoted.selector, id, alice));
        voting.vote(id, false); // 换立场也不行：一人一票
        vm.stopPrank();
        (uint256 f, uint256 a) = voting.tally(id);
        assertEq(f + a, 1);
    }

    function test_VoteAfterDeadlineReverts() public {
        uint256 id = _create(1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Voting.VotingClosed.selector, id, block.timestamp - 1));
        voting.vote(id, true);
    }

    function test_VoteAtDeadlineStillAllowed() public {
        uint256 id = _create(1 days);
        uint256 deadline = block.timestamp + 1 days;
        vm.warp(deadline); // 边界：deadline 当刻仍有效（> 才拒）
        vm.prank(alice);
        voting.vote(id, true);
        (uint256 f,) = voting.tally(id);
        assertEq(f, 1);
    }

    function test_UnknownProposalReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Voting.ProposalNotFound.selector, 99));
        voting.vote(99, true);
        vm.expectRevert(abi.encodeWithSelector(Voting.ProposalNotFound.selector, 99));
        voting.getProposal(99);
    }

    function test_IndependentProposalsHaveIndependentVotes() public {
        uint256 a = _create(1 days);
        uint256 b = _create(2 days);
        vm.startPrank(alice);
        voting.vote(a, true);
        voting.vote(b, false); // 同一人在不同提案各有一票
        vm.stopPrank();
        (uint256 fa,) = voting.tally(a);
        (, uint256 ab) = voting.tally(b);
        assertEq(fa, 1);
        assertEq(ab, 1);
    }

    // ---------- fuzz ----------

    function testFuzz_TallyConservesVoters(uint8 n) public {
        uint256 id = _create(1 days);
        uint256 voters = bound(uint256(n), 1, 50);
        uint256 yes;
        for (uint256 i = 0; i < voters; i++) {
            address v = address(uint160(0x1000 + i));
            bool support = i % 2 == 0;
            vm.prank(v);
            voting.vote(id, support);
            if (support) yes++;
        }
        (uint256 f, uint256 a) = voting.tally(id);
        assertEq(f, yes);
        assertEq(a, voters - yes);
        assertEq(f + a, voters);
    }

    function testFuzz_DoubleVoteAlwaysReverts(bool first, bool second) public {
        uint256 id = _create(1 days);
        vm.startPrank(alice);
        voting.vote(id, first);
        vm.expectRevert(abi.encodeWithSelector(Voting.AlreadyVoted.selector, id, alice));
        voting.vote(id, second);
        vm.stopPrank();
    }
}
