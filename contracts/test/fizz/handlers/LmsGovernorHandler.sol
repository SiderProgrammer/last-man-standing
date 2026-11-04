// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with LmsGovernor: a proposal's whole life.
abstract contract LmsGovernorHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Takes the proposal under way one step further, or makes one if there is
    ///      none. A vote only lands in its window, and the fuzzer cannot aim at a
    ///      window through random single steps, so the state picks the step here.
    function governor_advance_clamped(uint256 actorSeed, uint256 arg0, uint8 action) public {
        _useActor(actorSeed);
        for (uint256 i = 0; i < proposals.length; ++i) {
            uint256 id = proposals[i].id;
            IGovernor.ProposalState state = governor.state(id);
            if (state == IGovernor.ProposalState.Pending) return;
            if (state == IGovernor.ProposalState.Active) {
                _voteEveryone(id);
                return;
            }
            if (state == IGovernor.ProposalState.Succeeded) {
                _governor_queue(i);
                return;
            }
            if (state == IGovernor.ProposalState.Queued) {
                if (block.timestamp >= governor.proposalEta(id)) _governor_execute(i);
                return;
            }
        }
        _proposeAction(action, arg0);
    }

    function governor_secondary(uint8 selector, uint256 actorSeed, uint256 arg0, uint8 arg1) public {
        selector = uint8(selector % 5);
        _useActor(actorSeed);
        if (selector == 0) {
            _proposeAction(arg1, arg0);
        } else if (proposals.length == 0) {
            return;
        } else if (selector == 1) {
            _governor_castVote(proposals[arg0 % proposals.length].id, uint8(arg1 % 3));
        } else if (selector == 2) {
            _governor_queue(arg0 % proposals.length);
        } else if (selector == 3) {
            _governor_execute(arg0 % proposals.length);
        } else {
            _governor_setQuorumFloor(arg0);
        }
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function _governor_propose(address target, bytes memory data) internal asActor {
        address[] memory targets = new address[](1);
        targets[0] = target;
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = data;
        string memory description = string(abi.encodePacked("fizz proposal ", toString(++proposalNonce)));

        uint256 id = governor.propose(targets, values, calldatas, description);
        proposals.push(
            Proposal({
                targets: targets,
                values: values,
                calldatas: calldatas,
                descriptionHash: keccak256(bytes(description)),
                id: id
            })
        );
    }

    function _governor_castVote(uint256 id, uint8 support) internal asActor {
        governor.castVote(id, support);
        _afterCall();
    }

    function _governor_queue(uint256 index) internal asActor {
        Proposal storage p = proposals[index];
        governor.queue(p.targets, p.values, p.calldatas, p.descriptionHash);
        _afterCall();
    }

    function _governor_execute(uint256 index) internal asActor {
        Proposal storage p = proposals[index];
        governor.execute(p.targets, p.values, p.calldatas, p.descriptionHash);
        _afterCall();
    }

    /// @dev Direct from the timelock, not through a proposal: `onlyGovernance`
    ///      must refuse it. The real path is action 1 in `_proposeAction`.
    function _governor_setQuorumFloor(uint256 newQuorumFloor) internal asTimelock {
        governor.setQuorumFloor(newQuorumFloor);
        _afterCall();
    }

    // ――――――――――――――――――――――――― Private ――――――――――――――――――――――――――

    function _voteEveryone(uint256 id) private {
        uint256 snapshot = governor.proposalSnapshot(id);
        for (uint256 i = 0; i < actors.length; ++i) {
            if (stakedLms.getPastVotes(actors[i], snapshot) == 0 || governor.hasVoted(id, actors[i])) {
                continue;
            }
            actor = actors[i];
            _governor_castVote(id, 1);
        }
    }

    function _proposeAction(uint8 action, uint256 arg0) private {
        action = uint8(action % 4);
        if (action == 0) {
            _governor_propose(
                address(feeRouter),
                abi.encodeWithSelector(feeRouter.setStakerBps.selector, uint16(clampBetween(arg0, 0, 10_000)))
            );
        } else if (action == 1) {
            _governor_propose(
                address(governor),
                abi.encodeWithSelector(
                    bytes4(keccak256("setQuorumFloor(uint256)")),
                    clampBetween(arg0, 0, governor.maxQuorumFloor())
                )
            );
        } else if (action == 2) {
            _governor_propose(
                address(config),
                abi.encodeWithSelector(
                    config.setChallengeWindow.selector, uint64(clampBetween(arg0, 1, CHALLENGE_WINDOW))
                )
            );
        } else {
            _governor_propose(
                address(stakedLms),
                abi.encodeWithSelector(
                    stakedLms.setCooldown.selector, uint64(clampBetween(arg0, 1 days, 30 days))
                )
            );
        }
    }
}
