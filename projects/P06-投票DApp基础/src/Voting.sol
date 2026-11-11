// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice 最小投票闭环：owner 建提案（带截止）、一人一票 yes/no、链上计票。
///         教学合约：无代币加权、无委托、无时间锁——那些是 P19 的主题。
/// @dev 权限外置：admin 由构造参数传入（P04/P05 同款教训，不写死 msg.sender）。
contract Voting is Ownable {
    struct Proposal {
        string title;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ProposalCreated(uint256 indexed id, string title, uint256 deadline, address proposer);
    event Voted(uint256 indexed id, address indexed voter, bool support);

    error ProposalNotFound(uint256 id);
    error VotingClosed(uint256 id, uint256 deadline);
    error AlreadyVoted(uint256 id, address voter);
    error EmptyTitle();
    error ZeroDuration();

    constructor(address admin) Ownable(admin) {}

    function createProposal(string calldata title, uint256 duration) external onlyOwner returns (uint256 id) {
        if (bytes(title).length == 0) revert EmptyTitle();
        if (duration == 0) revert ZeroDuration();
        id = proposalCount++;
        uint256 deadline = block.timestamp + duration;
        _proposals[id] = Proposal({title: title, deadline: deadline, forVotes: 0, againstVotes: 0});
        emit ProposalCreated(id, title, deadline, msg.sender);
    }

    function vote(uint256 id, bool support) external {
        Proposal storage p = _proposals[id];
        if (p.deadline == 0) revert ProposalNotFound(id);
        if (block.timestamp > p.deadline) revert VotingClosed(id, p.deadline);
        if (hasVoted[id][msg.sender]) revert AlreadyVoted(id, msg.sender);
        hasVoted[id][msg.sender] = true;
        if (support) {
            p.forVotes += 1;
        } else {
            p.againstVotes += 1;
        }
        emit Voted(id, msg.sender, support);
    }

    function getProposal(uint256 id)
        external
        view
        returns (string memory title, uint256 deadline, uint256 forVotes, uint256 againstVotes)
    {
        Proposal storage p = _proposals[id];
        if (p.deadline == 0) revert ProposalNotFound(id);
        return (p.title, p.deadline, p.forVotes, p.againstVotes);
    }

    function tally(uint256 id) external view returns (uint256 forVotes, uint256 againstVotes) {
        Proposal storage p = _proposals[id];
        if (p.deadline == 0) revert ProposalNotFound(id);
        return (p.forVotes, p.againstVotes);
    }
}
