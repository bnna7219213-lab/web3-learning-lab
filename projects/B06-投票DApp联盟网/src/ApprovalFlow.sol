// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice 双人复核审批流（M5「补贴直达」核心流程原型）：
///         提案 → 复核(通过/驳回) → 生效延迟 → 执行；提案人在**撤销窗口**内可撤回。
///         把 P06 的「一人一票投票」升级为「多成员审批」：谁提案、谁复核、谁执行由角色决定，
///         且**提案人不能复核自己的提案**（双人复核的最小语义）。
/// @dev 权限外置：admin 由构造参数传入（P04/P05 同款教训）。事件即审计流水；
///      被拒的操作走 revert（错误数据带 actor），链上留痕 = status=0 回执（验收脚本断言）。
contract ApprovalFlow is AccessControl {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant REVIEWER_ROLE = keccak256("REVIEWER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    enum State {
        None,
        Pending, // 已提案，待复核
        Approved, // 复核通过，等待生效延迟
        Rejected, // 复核驳回
        Revoked, // 提案人在窗口内撤回
        Executed // 已执行（终态）
    }

    struct Proposal {
        address proposer;
        address reviewer;
        address target;
        uint256 value;
        bytes data;
        string title;
        uint64 approvedAt;
        uint64 executeAfter; // approvedAt + DELAY
        State state;
    }

    uint64 public immutable DELAY; // 生效延迟（秒）
    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;

    event Proposed(uint256 indexed id, address indexed proposer, string title);
    event Reviewed(uint256 indexed id, address indexed reviewer, bool approved, string reason);
    event Revoked(uint256 indexed id, address indexed by);
    event Executed(uint256 indexed id, address indexed by);

    error EmptyTitle();
    error ZeroAdmin();
    error ZeroDelay();
    error ProposalNotFound(uint256 id);
    error WrongState(uint256 id, State current);
    error ProposerCannotReview(uint256 id, address proposer);
    error TooEarly(uint256 id, uint64 executeAfter);
    error WindowClosed(uint256 id, uint64 executeAfter);
    error ExecFailed(uint256 id);

    constructor(address admin, uint64 delaySeconds) {
        if (admin == address(0)) revert ZeroAdmin();
        if (delaySeconds == 0) revert ZeroDelay();
        DELAY = delaySeconds;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice 提案（PROPOSER_ROLE）
    function propose(address target, uint256 value, bytes calldata data, string calldata title)
        external
        onlyRole(PROPOSER_ROLE)
        returns (uint256 id)
    {
        if (bytes(title).length == 0) revert EmptyTitle();
        id = proposalCount++;
        _proposals[id] = Proposal({
            proposer: msg.sender,
            reviewer: address(0),
            target: target,
            value: value,
            data: data,
            title: title,
            approvedAt: 0,
            executeAfter: 0,
            state: State.Pending
        });
        emit Proposed(id, msg.sender, title);
    }

    /// @notice 复核通过（REVIEWER_ROLE，且**不能是提案人**——双人复核）
    function approve(uint256 id) external onlyRole(REVIEWER_ROLE) {
        Proposal storage p = _proposals[id];
        if (p.state == State.None) revert ProposalNotFound(id);
        if (p.state != State.Pending) revert WrongState(id, p.state);
        if (msg.sender == p.proposer) revert ProposerCannotReview(id, p.proposer);
        p.reviewer = msg.sender;
        p.state = State.Approved;
        p.approvedAt = uint64(block.timestamp);
        p.executeAfter = uint64(block.timestamp) + DELAY;
        emit Reviewed(id, msg.sender, true, "");
    }

    /// @notice 复核驳回（REVIEWER_ROLE，带原因；同样不能是提案人）
    function reject(uint256 id, string calldata reason) external onlyRole(REVIEWER_ROLE) {
        Proposal storage p = _proposals[id];
        if (p.state == State.None) revert ProposalNotFound(id);
        if (p.state != State.Pending) revert WrongState(id, p.state);
        if (msg.sender == p.proposer) revert ProposerCannotReview(id, p.proposer);
        p.reviewer = msg.sender;
        p.state = State.Rejected;
        emit Reviewed(id, msg.sender, false, reason);
    }

    /// @notice 撤销窗口：复核通过后、生效延迟结束前，提案人可撤回
    function revoke(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (p.state == State.None) revert ProposalNotFound(id);
        if (p.state != State.Approved) revert WrongState(id, p.state);
        if (msg.sender != p.proposer) revert ProposerCannotReview(id, p.proposer);
        if (block.timestamp >= p.executeAfter) revert WindowClosed(id, p.executeAfter);
        p.state = State.Revoked;
        emit Revoked(id, msg.sender);
    }

    /// @notice 执行（EXECUTOR_ROLE）：生效延迟结束后触发链上动作。
    ///         目标调用失败则整体 revert（提案留在 Approved 可重试），成功才落 Executed 终态。
    function execute(uint256 id) external onlyRole(EXECUTOR_ROLE) {
        Proposal storage p = _proposals[id];
        if (p.state == State.None) revert ProposalNotFound(id);
        if (p.state != State.Approved) revert WrongState(id, p.state);
        if (block.timestamp < p.executeAfter) revert TooEarly(id, p.executeAfter);
        p.state = State.Executed; // 先落状态再外部调用（防重入同一提案）
        (bool ok,) = p.target.call{value: p.value}(p.data);
        if (!ok) revert ExecFailed(id); // 整体回滚 ⇒ 状态退回 Approved，可修复后重试
        emit Executed(id, msg.sender);
    }

    function getProposal(uint256 id)
        external
        view
        returns (
            address proposer,
            address reviewer,
            address target,
            uint256 value,
            bytes memory data,
            string memory title,
            uint64 approvedAt,
            uint64 executeAfter,
            State state
        )
    {
        Proposal storage p = _proposals[id];
        return (p.proposer, p.reviewer, p.target, p.value, p.data, p.title, p.approvedAt, p.executeAfter, p.state);
    }

    function stateOf(uint256 id) external view returns (State) {
        return _proposals[id].state;
    }
}
