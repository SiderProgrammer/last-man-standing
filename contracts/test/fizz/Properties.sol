// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import "./Base.sol";
import {
    BPS_DENOMINATOR,
    DISPUTE_EXTENSION,
    MAX_DISCOUNT_BPS,
    RANDOMNESS_TIMEOUT
} from "../../src/Constants.sol";

/// @notice Contains the functions that check the properties (invariants)
abstract contract Properties is PropertiesAsserts, Snapshots {
    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    // Every property: public, no arguments, returns true, asserts itself (a revert or a
    // failed assert is a failure). "Known addresses" = `_known()` (actors + `extraAddrs`);
    // once `ghosts.knownOverflow` is set, a sum over them can only be checked as an
    // upper bound, and `_sumEq` does that.
    // Properties that need history read bits of `ghosts.violated`, which `_afterCall()`
    // (Snapshots.sol) sets; they hold vacuously until handlers call it.

    function _sumEq(uint256 sumOfKnown, uint256 total, string memory reason) private {
        if (ghosts.knownOverflow) lte(sumOfKnown, total, reason);
        else eq(sumOfKnown, total, reason);
    }

    function _noViolation(uint256 bit, string memory reason) private {
        t((ghosts.violated & bit) == 0, reason);
    }

    /// @notice GL-01: the escrow's ETH equals totalOwed + totalEscrowed + ETH forced in.
    function property_escrowLedgerExact() public returns (bool) {
        eq(
            address(escrow).balance,
            escrow.totalOwed() + escrow.totalEscrowed() + ghosts.donatedEscrowEth,
            "GL-01: escrow balance != totalOwed + totalEscrowed + donated"
        );
        return true;
    }

    /// @dev Appends `account` to `list` unless it is zero or already there.
    function _pushUnique(address[] memory list, uint256 n, address account) private pure returns (uint256) {
        if (account == address(0)) return n;
        for (uint256 i = 0; i < n; ++i) {
            if (list[i] == account) return n;
        }
        list[n] = account;
        return n + 1;
    }

    /// @dev Every address the escrow can credit.
    function _creditors() private view returns (address[] memory out) {
        address[] memory known = _known();
        uint256 termsCount = escrow.termsCount();
        out = new address[](known.length + 9 + termsCount);
        uint256 n;
        for (uint256 i = 0; i < known.length; ++i) {
            n = _pushUnique(out, n, known[i]);
        }
        n = _pushUnique(out, n, address(feeRouter));
        n = _pushUnique(out, n, address(timelock));
        n = _pushUnique(out, n, safe);
        n = _pushUnique(out, n, address(bridgeReceiver));
        n = _pushUnique(out, n, outsider);
        n = _pushUnique(out, n, config.treasury());
        n = _pushUnique(out, n, admin);
        n = _pushUnique(out, n, guardian);
        n = _pushUnique(out, n, matchmaker);
        for (uint32 id = 1; id <= termsCount; ++id) {
            n = _pushUnique(out, n, escrow.getTerms(id).treasury);
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// @notice GL-02: totalOwed equals the sum of withdrawable over every creditor.
    function property_totalOwedIsSumOfBalances() public returns (bool) {
        address[] memory creditors = _creditors();
        uint256 sum;
        for (uint256 i = 0; i < creditors.length; ++i) {
            sum += escrow.withdrawable(creditors[i]);
        }
        _sumEq(sum, escrow.totalOwed(), "GL-02: totalOwed != sum of withdrawable");
        return true;
    }

    /// @dev Stake held and LMS held by one live match.
    function _liveHeld(bytes32 id, GameEscrow.MatchInfo memory m)
        private
        view
        returns (uint256 ethHeld, uint256 lmsHeld, bool ok)
    {
        address[] memory seats = escrow.getSeats(id);
        uint256 ethOff;
        for (uint256 i = 0; i < seats.length; ++i) {
            GameEscrow.Discount memory d = escrow.getSeatDiscount(id, seats[i]);
            ethOff += d.eth;
            lmsHeld += d.lms;
        }
        uint256 pool = uint256(m.stake) * m.seatCount;
        ok = ethOff <= pool;
        ethHeld = ok ? pool - ethOff : 0;
    }

    /// @notice GL-03: totalEscrowed equals the stake held by matches from Open to Proposed.
    function property_totalEscrowedIsSumOfLiveMatches() public returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < matchIds.length; ++i) {
            GameEscrow.MatchInfo memory m = escrow.getMatch(matchIds[i]);
            if (m.status < GameEscrow.MatchStatus.Open || m.status > GameEscrow.MatchStatus.Proposed) {
                continue;
            }
            (uint256 ethHeld,, bool ok) = _liveHeld(matchIds[i], m);
            t(ok, "GL-03: seat ETH discounts exceed the pool");
            sum += ethHeld;
        }
        eq(sum, escrow.totalEscrowed(), "GL-03: totalEscrowed != stake held by live matches");
        return true;
    }

    /// @notice GL-04: LMS held against live seats equals totalLmsEscrowed and is fully in custody.
    function property_lmsEscrowCustody() public returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < matchIds.length; ++i) {
            GameEscrow.MatchInfo memory m = escrow.getMatch(matchIds[i]);
            if (m.status < GameEscrow.MatchStatus.Open || m.status > GameEscrow.MatchStatus.Proposed) {
                continue;
            }
            (, uint256 lmsHeld,) = _liveHeld(matchIds[i], m);
            sum += lmsHeld;
        }
        eq(sum, escrow.totalLmsEscrowed(), "GL-04: totalLmsEscrowed != LMS held against live seats");
        eq(
            lms.balanceOf(address(escrow)),
            escrow.totalLmsEscrowed() + ghosts.lmsDirectIn[address(escrow)],
            "GL-04: escrow LMS balance != totalLmsEscrowed + LMS sent in"
        );
        return true;
    }

    /// @notice GL-05: match status only moves along legal edges (hook-observed).
    function property_matchStatusMachine() public returns (bool) {
        _noViolation(V_STATUS, "GL-05: illegal match status transition");
        return true;
    }

    /// @notice GL-06: per-match records and stored Terms are write-once (hook-observed).
    function property_matchRecordsImmutable() public returns (bool) {
        _noViolation(V_RECORD, "GL-06: a write-once match record or Terms changed");
        return true;
    }

    /// @notice GL-07: seat lists agree with seatCount, are distinct, and quorate once locked.
    function property_seatBookkeeping() public returns (bool) {
        for (uint256 i = 0; i < matchIds.length; ++i) {
            bytes32 id = matchIds[i];
            GameEscrow.MatchInfo memory m = escrow.getMatch(id);
            if (m.status == GameEscrow.MatchStatus.None) continue;
            address[] memory seats = escrow.getSeats(id);
            eq(seats.length, uint256(m.seatCount), "GL-07: seat list length != seatCount");
            lte(uint256(m.seatCount), uint256(m.maxSeats), "GL-07: seatCount > maxSeats");
            for (uint256 j = 0; j < seats.length; ++j) {
                t(escrow.hasSeat(id, seats[j]), "GL-07: listed seat does not hasSeat");
                for (uint256 k = j + 1; k < seats.length; ++k) {
                    t(seats[j] != seats[k], "GL-07: duplicate seat");
                }
            }
            if (m.status >= GameEscrow.MatchStatus.Pending && m.status != GameEscrow.MatchStatus.Cancelled) {
                gte(
                    uint256(m.seatCount),
                    uint256(escrow.getMatchTerms(id).minSeats),
                    "GL-07: locked below minSeats"
                );
            }
        }
        return true;
    }

    /// @notice GL-08: every seat of a matchmade lobby is on its roster.
    function property_matchmadeSeatsRostered() public returns (bool) {
        for (uint256 i = 0; i < matchIds.length; ++i) {
            bytes32 id = matchIds[i];
            if (!escrow.getMatch(id).matchmade) continue;
            address[] memory seats = escrow.getSeats(id);
            for (uint256 j = 0; j < seats.length; ++j) {
                t(escrow.rostered(id, seats[j]), "GL-08: seated player is not on the matchmade roster");
            }
        }
        return true;
    }

    /// @notice GL-09: per epoch, the players' feesPaid add up to epochFees, which never falls.
    function property_feeLedgerConsistent() public returns (bool) {
        _noViolation(V_FEE_DOWN, "GL-09: epochFees decreased");
        address[] memory known = _known();
        for (uint256 i = 0; i < feeEpochs.length; ++i) {
            uint256 e = feeEpochs[i];
            uint256 sum;
            for (uint256 j = 0; j < known.length; ++j) {
                sum += escrow.feesPaid(known[j], e);
            }
            _sumEq(sum, escrow.epochFees(e), "GL-09: sum of feesPaid != epochFees");
        }
        return true;
    }

    /// @notice GL-10: an ended fee epoch's totals never change (hook-observed).
    function property_endedEpochFrozen() public returns (bool) {
        _noViolation(V_EPOCH_FROZEN, "GL-10: an ended fee epoch changed");
        return true;
    }

    /// @notice GL-11: a Proposed match's deadline stays within one dispute extension of settle's.
    function property_challengeDeadlineBounded() public returns (bool) {
        _noViolation(V_DEADLINE, "GL-11: challenge deadline out of bounds");
        return true;
    }

    /// @notice GL-12: sLMS is backed one for one by LMS in the vault.
    function property_stakedLmsBacking() public returns (bool) {
        uint256 bal = lms.balanceOf(address(stakedLms));
        uint256 owedOut = stakedLms.totalSupply() + stakedLms.totalUnstaking();
        gte(bal, owedOut, "GL-12: vault LMS < totalSupply + totalUnstaking");
        eq(
            bal + ghosts.sweptStakedLms,
            owedOut + ghosts.lmsDirectIn[address(stakedLms)],
            "GL-12: vault LMS != supply + unstaking + sent in - swept"
        );
        return true;
    }

    /// @notice GL-13: StakedLms sums of parts, unstake entries and votes.
    function property_stakedLmsSumsAndVotes() public returns (bool) {
        address[] memory known = _known();
        uint256 sumAssets;
        uint256 sumBalances;
        uint256 sumDelegated;
        uint256 sumVotes;
        for (uint256 i = 0; i < known.length; ++i) {
            address a = known[i];
            (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(a);
            t((assets == 0) == (unlockAt == 0), "GL-13: unstake assets == 0 differs from unlockAt == 0");
            sumAssets += assets;
            uint256 bal = stakedLms.balanceOf(a);
            sumBalances += bal;
            if (stakedLms.delegates(a) != address(0)) sumDelegated += bal;
            sumVotes += stakedLms.getVotes(a);
        }
        _sumEq(sumAssets, stakedLms.totalUnstaking(), "GL-13: sum of unstake assets != totalUnstaking");
        _sumEq(sumBalances, stakedLms.totalSupply(), "GL-13: sum of sLMS balances != totalSupply");
        if (ghosts.knownOverflow) {
            lte(sumVotes, stakedLms.totalSupply(), "GL-13: votes of known addresses > totalSupply");
        } else {
            // Holds while every delegatee is a known address (handlers note them).
            eq(sumVotes, sumDelegated, "GL-13: sum of votes != delegated balances");
        }
        return true;
    }

    /// @notice GL-14: the vault holds at least the ETH its stakers have earned plus the unstreamed rest.
    function property_stakedLmsRewardsCovered() public returns (bool) {
        address[] memory known = _known();
        uint256 promised;
        for (uint256 i = 0; i < known.length; ++i) {
            try stakedLms.earned(known[i]) returns (uint256 e) {
                promised += e;
            } catch {
                t(false, "GL-14: earned() reverted");
            }
        }
        try stakedLms.rewardPerShare() returns (uint256) {}
        catch {
            t(false, "GL-14: rewardPerShare() reverted");
        }
        uint256 last = stakedLms.lastAccrual();
        uint256 finish = stakedLms.periodFinish();
        if (last < finish) {
            uint256 start =
                stakedLms.totalSupply() == 0 ? last : (block.timestamp > last ? block.timestamp : last);
            if (start < finish) promised += ((finish - start) * stakedLms.rewardRate()) / 1e27;
        }
        gte(address(stakedLms).balance, promised, "GL-14: vault ETH < earned + unstreamed rewards");
        return true;
    }

    /// @notice GL-15: the vault's ETH is what came in through depositRewards, less claims, plus forced ETH.
    function property_stakedLmsEthLedger() public returns (bool) {
        eq(
            address(stakedLms).balance + ghosts.stakedEthClaimed,
            ghosts.stakedEthDeposited + ghosts.donatedStakedEth,
            "GL-15: vault ETH != deposited - claimed + donated"
        );
        return true;
    }

    /// @notice GL-16: rewardPerShare and lastAccrual only move forward, and lastAccrual stays in range.
    function property_rewardAccumulatorsMonotone() public returns (bool) {
        _noViolation(V_ACCUMULATOR, "GL-16: rewardPerShare or lastAccrual decreased");
        uint256 last = stakedLms.lastAccrual();
        lte(last, block.timestamp, "GL-16: lastAccrual in the future");
        lte(last, uint256(stakedLms.periodFinish()), "GL-16: lastAccrual > periodFinish");
        return true;
    }

    // GL-17 (dust bound after a stream ends) is EXPLORATORY and LOW priority; left unimplemented.

    /// @notice GL-18: vesting books balance and every tranche vests within bounds.
    function property_vestingBooks() public returns (bool) {
        address[] memory known = _known();
        uint256 first = rewards.firstEpoch();
        uint256 sumAmount;
        uint256 sumReleased;
        for (uint256 i = 0; i < feeEpochs.length; ++i) {
            uint256 e = feeEpochs[i];
            if (e < first || escrow.epochFees(e) == 0) continue;
            for (uint256 j = 0; j < known.length; ++j) {
                (uint128 amount, uint128 released) = vesting.trancheOf(known[j], e);
                if (amount == 0) {
                    eq(uint256(released), 0, "GL-18: released from an empty tranche");
                    continue;
                }
                sumAmount += amount;
                sumReleased += released;
                uint256 vested = vesting.vested(known[j], e);
                lte(uint256(released), vested, "GL-18: released > vested");
                lte(vested, uint256(amount), "GL-18: vested > amount");
                uint256 start = vesting.vestingStart(e);
                if (block.timestamp <= start) eq(vested, 0, "GL-18: vested before the start");
                if (block.timestamp >= start + vesting.VESTING_DURATION()) {
                    eq(vested, uint256(amount), "GL-18: not fully vested at the end");
                }
            }
        }
        _sumEq(sumAmount, vesting.totalGranted(), "GL-18: sum of tranches != totalGranted");
        _sumEq(sumReleased, vesting.totalReleased(), "GL-18: sum of released != totalReleased");
        lte(vesting.totalReleased(), vesting.totalGranted(), "GL-18: totalReleased > totalGranted");
        eq(
            lms.balanceOf(address(vesting)) + vesting.totalReleased(),
            vesting.totalGranted() + ghosts.lmsDirectIn[address(vesting)],
            "GL-18: vesting LMS != granted - released + sent in"
        );
        return true;
    }

    /// @notice GL-19: play-mining never pays out more than its epoch budgets.
    function property_rewardsBudget() public returns (bool) {
        address[] memory known = _known();
        uint256 first = rewards.firstEpoch();
        for (uint256 i = 0; i < feeEpochs.length; ++i) {
            uint256 e = feeEpochs[i];
            if (e < first) {
                eq(rewards.epochBudget(e), 0, "GL-19: budget before the program");
                continue;
            }
            uint256 fees = escrow.epochFees(e);
            if (fees == 0) continue;
            uint256 budget = rewards.epochBudget(e);
            (uint256 rate, uint256 walletCap, bool fixed_) = rewards.rateOf(e);
            uint256 sum;
            for (uint256 j = 0; j < known.length; ++j) {
                (uint128 amount,) = vesting.trancheOf(known[j], e);
                if (fixed_) lte(uint256(amount), walletCap, "GL-19: tranche > wallet cap");
                sum += amount;
            }
            lte(sum, budget, "GL-19: tranches of an epoch > epochBudget");
            if (fixed_) lte(rate * fees, budget * 1e18, "GL-19: fixed rate * epochFees > budget");
        }
        // The budget curve: zero outside the program, never rising from one year to the next.
        eq(rewards.epochBudget(first + rewards.PROGRAM_EPOCHS()), 0, "GL-19: budget after the program");
        uint256 perYear = rewards.EPOCHS_PER_YEAR();
        for (uint256 y = 1; y < rewards.PROGRAM_YEARS(); ++y) {
            lte(
                rewards.epochBudget(first + y * perYear),
                rewards.epochBudget(first + (y - 1) * perYear),
                "GL-19: epochBudget rises year on year"
            );
        }
        lte(vesting.totalGranted(), rewards.totalBudget(), "GL-19: totalGranted > totalBudget");
        lte(rewards.totalBudget(), PLAY_MINING_SHARE, "GL-19: totalBudget > PLAY_MINING_SHARE");
        eq(
            lms.balanceOf(address(rewards)) + vesting.totalGranted() + ghosts.rewardsSwept,
            PLAY_MINING_SHARE + ghosts.lmsDirectIn[address(rewards)],
            "GL-19: rewards LMS + granted != share - swept + sent in"
        );
        return true;
    }

    /// @notice GL-20: an epoch's reward rate and wallet cap are write-once (hook-observed).
    function property_rateWriteOnce() public returns (bool) {
        _noViolation(V_REWARD_TERMS, "GL-20: a fixed reward term, claim flag or tranche changed");
        return true;
    }

    /// @notice GL-21: LMS supply is the initial supply less what was burned.
    function property_lmsSupplyConserved() public returns (bool) {
        eq(lms.totalSupply() + ghosts.burnedLms, LMS_SUPPLY, "GL-21: LMS totalSupply != supply - burned");
        eq(lms.balanceOf(address(0)), 0, "GL-21: LMS held at address(0)");
        return true;
    }

    /// @notice GL-22: the liquidity reserve conserves LMS and approves no forbidden recipient.
    function property_reserveCustody() public returns (bool) {
        eq(
            lms.balanceOf(address(reserve)) + ghosts.reserveReleased,
            LIQUIDITY_SHARE + ghosts.lmsDirectIn[address(reserve)],
            "GL-22: reserve LMS != share - released + sent in"
        );
        t(!reserve.isApproved(address(stakedLms)), "GL-22: the vault is an approved recipient");
        t(!reserve.isApproved(safe), "GL-22: the Safe is an approved recipient");
        t(!reserve.isApproved(address(reserve)), "GL-22: the reserve is an approved recipient");
        t(!reserve.isApproved(address(0)), "GL-22: address(0) is an approved recipient");
        return true;
    }

    /// @notice GL-23: a pause not set by governance is a guardian pause, at most GUARDIAN_PAUSE long.
    function property_pauseFlagsConsistent() public returns (bool) {
        if (escrow.pausedByGovernance()) return true;
        uint256 until = escrow.pausedUntil();
        // A guardian pause ends at most GUARDIAN_PAUSE after it began, which was not after now.
        lte(
            until,
            block.timestamp + escrow.GUARDIAN_PAUSE(),
            "GL-23: guardian pause longer than GUARDIAN_PAUSE"
        );
        if (ghosts.lastGuardianPauseAt != 0) {
            lte(
                until,
                uint256(ghosts.lastGuardianPauseAt) + escrow.GUARDIAN_PAUSE(),
                "GL-23: pausedUntil > last guardian pause + GUARDIAN_PAUSE"
            );
        }
        return true;
    }

    /// @notice GL-24: the FeeRouter holds only ETH forced in since its last harvest.
    function property_feeRouterHoldsOnlyDonations() public returns (bool) {
        eq(
            address(feeRouter).balance,
            ghosts.donatedRouterEth,
            "GL-24: FeeRouter ETH != donations since harvest"
        );
        return true;
    }

    /// @notice GL-25: session keys stay within their caps and lifetime.
    function property_sessionCaps() public returns (bool) {
        _noViolation(V_SESSION, "GL-25: sessionNonce decreased");
        for (uint256 i = 0; i < sessionAccounts.length; ++i) {
            address account = address(sessionAccounts[i]);
            for (uint256 j = 0; j < sessionKeys.length; ++j) {
                (uint48 validUntil, uint128 valueCap, uint128 spendCap, uint128 spent) =
                    sessionAccounts[i].sessions(sessionKeys[j]);
                lte(uint256(spent), uint256(spendCap), "GL-25: spent > spendCap");
                lte(uint256(valueCap), uint256(spendCap), "GL-25: valueCap > spendCap");
                if (validUntil == 0) continue;
                // Granted no later than now, so it cannot end later than now plus the maximum.
                lte(
                    uint256(validUntil),
                    block.timestamp + sessionAccounts[i].MAX_SESSION_DURATION(),
                    "GL-25: session outlives MAX_SESSION_DURATION"
                );
                uint64 granted = ghosts.grantTime[account][sessionKeys[j]];
                if (granted != 0) {
                    lte(
                        uint256(validUntil),
                        uint256(granted) + sessionAccounts[i].MAX_SESSION_DURATION(),
                        "GL-25: validUntil > grantTime + MAX_SESSION_DURATION"
                    );
                }
            }
        }
        return true;
    }

    /// @notice GL-26: governance tallies are bounded by the supply and quorate once a proposal passes.
    function property_governanceTallies() public returns (bool) {
        for (uint256 i = 0; i < proposals.length; ++i) {
            uint256 id = proposals[i].id;
            uint256 snapshot;
            try governor.proposalSnapshot(id) returns (uint256 s) {
                snapshot = s;
            } catch {
                continue;
            }
            // Past supply and quorum can only be read for a timepoint that has gone by.
            if (snapshot >= block.timestamp) continue;
            (uint256 against, uint256 forVotes, uint256 abstain) = governor.proposalVotes(id);
            lte(
                against + forVotes + abstain,
                stakedLms.getPastTotalSupply(snapshot),
                "GL-26: votes cast > sLMS supply at the snapshot"
            );
            IGovernor.ProposalState st = governor.state(id);
            if (
                st == IGovernor.ProposalState.Succeeded || st == IGovernor.ProposalState.Queued
                    || st == IGovernor.ProposalState.Executed
            ) {
                gte(forVotes + abstain, governor.quorum(snapshot), "GL-26: passed without quorum");
                gte(governor.quorum(snapshot), governor.quorumFloor(snapshot), "GL-26: quorum < quorumFloor");
                gt(forVotes, against, "GL-26: passed without more for than against");
            }
        }
        return true;
    }

    /// @notice GL-27: proposal state only moves forward (hook-observed).
    function property_proposalStateForward() public returns (bool) {
        _noViolation(V_PROPOSAL_STATE, "GL-27: proposal state moved backwards or left a terminal state");
        return true;
    }

    /// @notice GL-28: the multisig phase keeps both timelock roles until it retires, then neither.
    function property_phaseRetiredHasNoRoles() public returns (bool) {
        _noViolation(V_PHASE, "GL-28: phase roles lost early, split, or regained");
        if (ghosts.phaseRetired) {
            t(
                !timelock.hasRole(keccak256("PROPOSER_ROLE"), address(phase))
                    && !timelock.hasRole(keccak256("CANCELLER_ROLE"), address(phase)),
                "GL-28: retired phase still holds a timelock role"
            );
        }
        return true;
    }

    /// @notice GL-29: ownership stays with the timelock and the timelock keeps its LMS (EXPLORATORY).
    function property_ownershipAndTimelockLms() public returns (bool) {
        address owner_ = address(timelock);
        t(config.owner() == owner_, "GL-29: config owner moved");
        t(vrf.owner() == owner_, "GL-29: vrf adapter owner moved");
        t(stakedLms.owner() == owner_, "GL-29: StakedLms owner moved");
        t(feeRouter.owner() == owner_, "GL-29: FeeRouter owner moved");
        t(rewards.owner() == owner_, "GL-29: RewardsDistributor owner moved");
        t(reserve.owner() == owner_, "GL-29: LiquidityReserve owner moved");
        t(bridgeReceiver.owner() == owner_, "GL-29: BridgeJoinReceiver owner moved");
        gte(
            lms.balanceOf(owner_),
            ghosts.timelockLmsFloor,
            "GL-29: timelock LMS fell below its initial balance"
        );
        return true;
    }

    /// @notice GL-30: attestor-set history and the LMS token are immutable, and the delay outlasts a match.
    function property_configHistoryAndLifetime() public returns (bool) {
        _noViolation(V_CONFIG, "GL-30: attestor-set history, version or lmsToken changed");
        lt(config.matchLifetime(), timelock.getMinDelay(), "GL-30: matchLifetime >= timelock min delay");
        return true;
    }

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.

    // ─── Snapshot structs and helpers for the specific properties (memory, per call) ───

    /// @dev Escrow-wide picture taken just before a call. `who` is the set of addresses a
    ///      credit can land on (actors, the registry of addresses handlers were given,
    ///      the router, timelock, safe, outsider, bridge receiver, treasuries, `extra`).
    struct SpPre {
        uint256 bal;
        uint256 owed;
        uint256 escrowed;
        uint256 lmsEsc;
        uint256 lmsEscBal;
        uint256 lmsSupply;
        uint256 epoch;
        uint256 epochFees;
        address[] who;
        uint256[] w;
        uint256[] fees;
        uint256[] lmsBal;
    }

    /// @dev A match as it stood before a call, with its seat discounts summed.
    struct SpMatch {
        GameEscrow.MatchInfo info;
        GameEscrow.Terms terms;
        address[] seats;
        GameEscrow.Discount[] disc;
        uint256 discEth;
        uint256 discLms;
    }

    /// @dev Seats that have disputed a result (SP-16: once each).
    mapping(bytes32 matchId => mapping(address player => bool)) internal spDisputedBy;

    function _spAdd(address[] memory list, uint256 n, address a) private pure returns (uint256) {
        if (a == address(0)) return n;
        for (uint256 i; i < n; ++i) {
            if (list[i] == a) return n;
        }
        list[n] = a;
        return n + 1;
    }

    function _spExtra() internal view returns (address[] memory) {
        return ghosts.extraAddrs;
    }

    function _spWho(address extra) internal view returns (address[] memory out) {
        address[] memory more = _spExtra();
        address[] memory tmp = new address[](actors.length + more.length + 9);
        uint256 n;
        for (uint256 i; i < actors.length; ++i) {
            n = _spAdd(tmp, n, actors[i]);
        }
        for (uint256 i; i < more.length; ++i) {
            n = _spAdd(tmp, n, more[i]);
        }
        n = _spAdd(tmp, n, address(feeRouter));
        n = _spAdd(tmp, n, address(timelock));
        n = _spAdd(tmp, n, safe);
        n = _spAdd(tmp, n, outsider);
        n = _spAdd(tmp, n, address(bridgeReceiver));
        n = _spAdd(tmp, n, config.getParams().treasury);
        n = _spAdd(tmp, n, feeRouter.treasury());
        n = _spAdd(tmp, n, extra);
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    function _spPre(address extra) internal view returns (SpPre memory p) {
        p.bal = address(escrow).balance;
        p.owed = escrow.totalOwed();
        p.escrowed = escrow.totalEscrowed();
        p.lmsEsc = escrow.totalLmsEscrowed();
        p.lmsEscBal = lms.balanceOf(address(escrow));
        p.lmsSupply = lms.totalSupply();
        p.epoch = block.timestamp / escrow.FEE_EPOCH();
        p.epochFees = escrow.epochFees(p.epoch);
        p.who = _spWho(extra);
        uint256 n = p.who.length;
        p.w = new uint256[](n);
        p.fees = new uint256[](n);
        p.lmsBal = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            p.w[i] = escrow.withdrawable(p.who[i]);
            p.fees[i] = escrow.feesPaid(p.who[i], p.epoch);
            p.lmsBal[i] = lms.balanceOf(p.who[i]);
        }
    }

    function _spMatch(bytes32 id) internal view returns (SpMatch memory m) {
        m.info = escrow.getMatch(id);
        m.terms = escrow.getMatchTerms(id);
        m.seats = escrow.getSeats(id);
        m.disc = new GameEscrow.Discount[](m.seats.length);
        for (uint256 i; i < m.seats.length; ++i) {
            m.disc[i] = escrow.getSeatDiscount(id, m.seats[i]);
            m.discEth += m.disc[i].eth;
            m.discLms += m.disc[i].lms;
        }
    }

    function _spSeat(SpMatch memory m, address a)
        private
        pure
        returns (bool seated, uint256 ethOff, uint256 lmsPaid)
    {
        for (uint256 i; i < m.seats.length; ++i) {
            if (m.seats[i] == a) return (true, m.disc[i].eth, m.disc[i].lms);
        }
    }

    /// @dev Revert data starting with `EnforcedPause()` from an exit is SP-14's violation.
    ///      Anything else is rethrown unchanged, so the handler keeps its meaning.
    function _spExitFailed(bytes memory reason, string memory what) internal {
        if (reason.length >= 4 && bytes4(reason) == bytes4(keccak256("EnforcedPause()"))) {
            t(false, what);
        }
        assembly ("memory-safe") {
            revert(add(reason, 32), mload(reason))
        }
    }

    function _spMoneyFlat(SpPre memory p, string memory what) private {
        eq(address(escrow).balance, p.bal, what);
        eq(escrow.totalOwed(), p.owed, what);
        eq(escrow.totalEscrowed(), p.escrowed, what);
        eq(escrow.totalLmsEscrowed(), p.lmsEsc, what);
    }

    // ─── SP-01 / SP-02: joins ───

    /// @notice SP-01: a join, joinFor or joinWithLms seats exactly the joiner and moves exactly `paid`
    function property_joinSeatAccounting(
        SpPre memory p,
        SpMatch memory m,
        bytes32 id,
        address joiner,
        uint256 paid,
        uint256 lmsUsed
    ) internal {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        eq(
            uint256(a.seatCount),
            uint256(m.info.seatCount) + 1,
            "SP-01: seatCount did not rise by exactly one"
        );
        eq(uint256(a.status), uint256(GameEscrow.MatchStatus.Open), "SP-01: join changed the match status");
        t(escrow.hasSeat(id, joiner), "SP-01: the joiner has no seat");
        address[] memory seats = escrow.getSeats(id);
        eq(seats.length, m.seats.length + 1, "SP-01: seat list did not grow by one");
        if (seats.length == m.seats.length + 1) {
            for (uint256 i; i < m.seats.length; ++i) {
                t(seats[i] == m.seats[i], "SP-01: an existing seat changed");
            }
            t(seats[m.seats.length] == joiner, "SP-01: the new seat is not the joiner's");
        }
        eq(escrow.totalEscrowed(), p.escrowed + paid, "SP-01: totalEscrowed did not rise by the ETH paid");
        eq(escrow.totalOwed(), p.owed, "SP-01: a join changed totalOwed");
        eq(address(escrow).balance, p.bal + paid, "SP-01: escrow balance did not rise by the ETH paid");
        eq(
            escrow.totalLmsEscrowed(),
            p.lmsEsc + lmsUsed,
            "SP-01: totalLmsEscrowed did not rise by the LMS used"
        );
        eq(
            lms.balanceOf(address(escrow)),
            p.lmsEscBal + lmsUsed,
            "SP-01: escrow LMS did not rise by the LMS used"
        );
        GameEscrow.Discount memory d = escrow.getSeatDiscount(id, joiner);
        eq(uint256(d.lms), lmsUsed, "SP-01: seat LMS discount differs from the LMS used");
        eq(uint256(d.eth) + paid, uint256(a.stake), "SP-01: seat ETH discount is not stake - paid");
        for (uint256 i; i < p.who.length; ++i) {
            eq(escrow.withdrawable(p.who[i]), p.w[i], "SP-01: a join changed a withdrawable balance");
        }
    }

    /// @notice SP-02: LMS buys the quoted discount, never more than the cap or than it is worth
    function property_lmsDiscountBounds(
        SpMatch memory m,
        bytes32 id,
        address joiner,
        uint256 lmsIn,
        uint256 qDisc,
        uint256 qLms,
        uint256 rate
    ) internal {
        GameEscrow.Discount memory d = escrow.getSeatDiscount(id, joiner);
        eq(uint256(d.eth), qDisc, "SP-02: stored discount differs from the quote");
        eq(uint256(d.lms), qLms, "SP-02: stored LMS differs from the quote");
        uint256 fee = (uint256(m.info.stake) * m.terms.feeBps) / BPS_DENOMINATOR;
        lte(
            uint256(d.eth),
            (fee * MAX_DISCOUNT_BPS) / BPS_DENOMINATOR,
            "SP-02: discount above MAX_DISCOUNT_BPS of the fee"
        );
        lte(uint256(d.lms), lmsIn, "SP-02: used more LMS than offered");
        lte(uint256(d.eth) * rate, uint256(d.lms) * 1e18, "SP-02: discount worth more than the LMS paid");
        if (d.eth > 0) gt(uint256(d.lms), 0, "SP-02: discount with no LMS paid");
    }

    // ─── SP-04: config snapshotted at create and lock ───

    /// @notice SP-04: createMatch(made) opens an Open lobby on the terms the config held at that moment
    function property_createSnapshotsConfig(
        SpPre memory p,
        bytes32 id,
        uint256 nonceBefore,
        uint32 termsBefore,
        uint128 stake,
        uint16 maxSeats,
        bool matchmade
    ) internal {
        eq(escrow.matchNonce(), nonceBefore + 1, "SP-04: matchNonce did not rise by one");
        t(
            id == keccak256(abi.encode(block.chainid, address(escrow), nonceBefore)),
            "SP-04: unexpected match id"
        );
        GameEscrow.MatchInfo memory m = escrow.getMatch(id);
        eq(uint256(m.status), uint256(GameEscrow.MatchStatus.Open), "SP-04: new match is not Open");
        eq(uint256(m.stake), uint256(stake), "SP-04: stake differs from the request");
        eq(uint256(m.maxSeats), uint256(maxSeats), "SP-04: maxSeats differs from the request");
        t(m.matchmade == matchmade, "SP-04: matchmade flag wrong");
        eq(uint256(m.seatCount), 0, "SP-04: new match has seats");
        ProtocolConfig.Params memory prm = config.getParams();
        eq(
            uint256(m.joinDeadline),
            block.timestamp + prm.joinWindow,
            "SP-04: joinDeadline is not now + joinWindow"
        );
        GameEscrow.Terms memory tm = escrow.getMatchTerms(id);
        t(tm.rulesHash == config.rulesHash(), "SP-04: Terms rulesHash differs from config");
        t(tm.treasury == prm.treasury, "SP-04: Terms treasury differs from config");
        eq(uint256(tm.feeBps), uint256(prm.feeBps), "SP-04: Terms feeBps differs from config");
        eq(uint256(tm.minSeats), uint256(prm.minSeats), "SP-04: Terms minSeats differs from config");
        eq(uint256(tm.joinWindow), uint256(prm.joinWindow), "SP-04: Terms joinWindow differs from config");
        eq(
            uint256(tm.settleWindow),
            uint256(prm.settleWindow),
            "SP-04: Terms settleWindow differs from config"
        );
        eq(
            uint256(tm.challengeWindow),
            uint256(config.challengeWindow()),
            "SP-04: Terms challengeWindow differs from config"
        );
        uint16[] memory sched = config.getPayoutSchedule();
        eq(tm.payoutBps.length, sched.length, "SP-04: Terms payout schedule length differs from config");
        if (tm.payoutBps.length == sched.length) {
            for (uint256 i; i < sched.length; ++i) {
                eq(
                    uint256(tm.payoutBps[i]),
                    uint256(sched[i]),
                    "SP-04: Terms payout entry differs from config"
                );
            }
        }
        uint32 count = escrow.termsCount();
        t(count == termsBefore || count == termsBefore + 1, "SP-04: termsCount moved by more than one");
        if (count == termsBefore + 1) eq(uint256(m.termsId), uint256(count), "SP-04: new Terms not used");
        t(m.termsId >= 1 && m.termsId <= count, "SP-04: termsId out of range");
        _spMoneyFlat(p, "SP-04: creating a lobby moved money");
    }

    /// @notice SP-04: lockMatch moves Open to Pending, snapshotting the oracle and attestor set
    function property_lockSnapshotsConfig(SpPre memory p, SpMatch memory m, bytes32 id) internal {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        eq(
            uint256(a.status),
            uint256(GameEscrow.MatchStatus.Pending),
            "SP-04: lock did not make the match Pending"
        );
        t(a.oracle == config.randomnessOracle(), "SP-04: locked oracle differs from config");
        eq(
            uint256(a.attestorSetVersion),
            uint256(config.attestorSetVersion()),
            "SP-04: locked attestor set differs from config"
        );
        eq(
            uint256(a.deadline),
            block.timestamp + RANDOMNESS_TIMEOUT,
            "SP-04: seed deadline is not now + RANDOMNESS_TIMEOUT"
        );
        eq(uint256(a.seatCount), uint256(m.info.seatCount), "SP-04: lock changed the seat count");
        _spMoneyFlat(p, "SP-04: locking moved money");
    }

    // ─── SP-05: randomness delivery ───

    /// @notice SP-05: an answered request seeds a Pending match once, with keccak(word, id)
    function property_randomnessDelivery(
        SpPre memory p,
        GameEscrow.MatchInfo memory before_,
        bytes32 id,
        bytes32 word
    ) internal {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        _spMoneyFlat(p, "SP-05: randomness delivery moved money");
        if (before_.status == GameEscrow.MatchStatus.Pending && a.status == GameEscrow.MatchStatus.Live) {
            t(a.seed == keccak256(abi.encode(word, id)), "SP-05: seed is not keccak(word, matchId)");
            eq(
                uint256(a.deadline),
                block.timestamp + escrow.getMatchTerms(id).settleWindow,
                "SP-05: settle deadline is not now + settleWindow"
            );
        } else if (before_.status != GameEscrow.MatchStatus.Pending) {
            eq(
                uint256(a.status),
                uint256(before_.status),
                "SP-05: a delivery moved a match that was not Pending"
            );
            t(a.seed == before_.seed, "SP-05: a delivery changed a seed");
        }
    }

    // ─── SP-06 / SP-07: settle ───

    /// @notice SP-06: settle moves Live to Proposed with exactly the signed ranking and pays nothing
    function property_settleProposes(SpPre memory p, bytes32 id, uint32 rounds, address[] memory ranking)
        internal
    {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        eq(uint256(a.status), uint256(GameEscrow.MatchStatus.Proposed), "SP-06: settle did not propose");
        t(a.rankingHash == keccak256(abi.encode(ranking)), "SP-06: rankingHash is not the signed ranking's");
        eq(uint256(a.rounds), uint256(rounds), "SP-06: stored rounds differ from the signed rounds");
        t(rounds >= 1 && rounds <= type(uint16).max, "SP-06: rounds out of 1..65535");
        eq(
            uint256(a.deadline),
            block.timestamp + escrow.getMatchTerms(id).challengeWindow,
            "SP-06: deadline is not now + challengeWindow"
        );
        t(!a.disputed, "SP-06: a fresh proposal is already disputed");
        eq(ranking.length, uint256(a.seatCount), "SP-06: ranking length differs from the seat count");
        for (uint256 i; i < ranking.length; ++i) {
            t(escrow.hasSeat(id, ranking[i]), "SP-06: ranking holds a non-seat");
            for (uint256 j = i + 1; j < ranking.length; ++j) {
                t(ranking[i] != ranking[j], "SP-06: ranking repeats a seat");
            }
        }
        _spMoneyFlat(p, "SP-06: settle moved money");
    }

    /// @notice SP-07: a settle that is not the signed result must be refused
    function property_forgedResultRejected(
        address caller,
        bytes32 id,
        uint32 rounds,
        bytes32 root,
        bytes32 transcript,
        address[] memory ranking,
        bytes memory signatures,
        string memory what
    ) internal {
        vm.prank(caller);
        try escrow.settle(id, rounds, root, transcript, ranking, signatures) {
            t(false, what);
        } catch {}
    }

    /// @notice SP-07: finalize with a ranking other than the proposed one must be refused
    function property_permutedFinalizeRejected(address caller, bytes32 id, address[] memory ranking)
        internal
    {
        if (ranking.length < 2) return;
        address[] memory swapped = new address[](ranking.length);
        for (uint256 i; i < ranking.length; ++i) {
            swapped[i] = ranking[i];
        }
        (swapped[0], swapped[1]) = (swapped[1], swapped[0]);
        vm.prank(caller);
        try escrow.finalize(id, swapped) {
            t(false, "SP-07: finalize accepted a ranking other than the proposed one");
        } catch {}
    }

    // ─── SP-08 .. SP-11: finalize and refunds ───

    function _spPayout(SpMatch memory m, address[] memory ranking)
        private
        pure
        returns (uint256 paid, uint256 remainder)
    {
        uint256 pool = uint256(m.info.stake) * m.info.seatCount;
        uint256 distributable = pool - (pool * m.terms.feeBps) / BPS_DENOMINATOR;
        for (uint256 i; i < m.terms.payoutBps.length && i < ranking.length; ++i) {
            paid += (distributable * m.terms.payoutBps[i]) / BPS_DENOMINATOR;
        }
        remainder = pool - paid - m.discEth;
    }

    /// @notice SP-08: finalize moves the pool from escrowed to owed, burns the discount LMS, nothing else
    function property_finalizeConserves(SpPre memory p, SpMatch memory m, bytes32 id) internal {
        uint256 held = uint256(m.info.stake) * m.info.seatCount - m.discEth;
        eq(
            uint256(uint8(escrow.getMatch(id).status)),
            uint256(uint8(GameEscrow.MatchStatus.Settled)),
            "SP-08: finalize did not settle"
        );
        eq(escrow.totalEscrowed() + held, p.escrowed, "SP-08: totalEscrowed did not fall by the held pool");
        eq(escrow.totalOwed(), p.owed + held, "SP-08: totalOwed did not rise by the held pool");
        eq(address(escrow).balance, p.bal, "SP-08: finalize moved ETH");
        eq(
            escrow.totalLmsEscrowed() + m.discLms,
            p.lmsEsc,
            "SP-08: totalLmsEscrowed did not fall by the discount LMS"
        );
        eq(
            lms.balanceOf(address(escrow)) + m.discLms,
            p.lmsEscBal,
            "SP-08: escrow LMS did not fall by the discount LMS"
        );
        eq(lms.totalSupply() + m.discLms, p.lmsSupply, "SP-08: LMS supply did not fall by the burn");
        for (uint256 i; i < p.who.length; ++i) {
            eq(lms.balanceOf(p.who[i]), p.lmsBal[i], "SP-08: finalize moved LMS to someone");
        }
    }

    /// @notice SP-09: finalize pays each rank floor(distributable * bps / 1e4) from the match's Terms
    function property_finalizePayouts(SpPre memory p, SpMatch memory m, address[] memory ranking) internal {
        uint256 pool = uint256(m.info.stake) * m.info.seatCount;
        uint256 distributable = pool - (pool * m.terms.feeBps) / BPS_DENOMINATOR;
        (, uint256 remainder) = _spPayout(m, ranking);
        for (uint256 k; k < p.who.length; ++k) {
            uint256 expected;
            for (uint256 j; j < m.terms.payoutBps.length && j < ranking.length; ++j) {
                if (ranking[j] == p.who[k]) {
                    expected += (distributable * m.terms.payoutBps[j]) / BPS_DENOMINATOR;
                }
            }
            if (p.who[k] == m.terms.treasury) expected += remainder;
            eq(
                escrow.withdrawable(p.who[k]),
                p.w[k] + expected,
                "SP-09: a credit differs from the Terms' schedule"
            );
        }
        gte(
            remainder + m.discEth,
            (pool * m.terms.feeBps) / BPS_DENOMINATOR,
            "SP-09: treasury credit below the fee less discounts"
        );
    }

    /// @notice SP-10: finalize records the net fee of a matchmade lobby in this epoch, and nothing otherwise
    function property_finalizeFeeLedger(SpPre memory p, SpMatch memory m, address[] memory ranking) internal {
        uint256 fee = (uint256(m.info.stake) * m.terms.feeBps) / BPS_DENOMINATOR;
        bool counts = m.info.matchmade && fee > 0;
        for (uint256 k; k < p.who.length; ++k) {
            uint256 net;
            if (counts) {
                (bool seated, uint256 ethOff,) = _spSeat(m, p.who[k]);
                if (seated) net = fee - ethOff;
            }
            eq(
                escrow.feesPaid(p.who[k], p.epoch),
                p.fees[k] + net,
                "SP-10: a player's feesPaid differs from the net fee"
            );
        }
        if (counts) {
            uint256 sum;
            for (uint256 i; i < m.seats.length; ++i) {
                sum += fee - m.disc[i].eth;
            }
            eq(
                escrow.epochFees(p.epoch),
                p.epochFees + sum,
                "SP-10: epochFees did not rise by the sum of net fees"
            );
            (, uint256 remainder) = _spPayout(m, ranking);
            lte(sum, remainder, "SP-10: recorded fees exceed the treasury's real credit");
        } else {
            eq(
                escrow.epochFees(p.epoch),
                p.epochFees,
                "SP-10: epochFees moved for a lobby that does not count"
            );
        }
    }

    /// @notice SP-11: cancel, abort and veto refund every seat stake - discount and its LMS, nothing burned
    function property_refundExact(SpPre memory p, SpMatch memory m, bytes32 id) internal {
        uint256 held = uint256(m.info.stake) * m.info.seatCount - m.discEth;
        eq(
            uint256(uint8(escrow.getMatch(id).status)),
            uint256(uint8(GameEscrow.MatchStatus.Cancelled)),
            "SP-11: refund path did not cancel"
        );
        eq(
            escrow.totalEscrowed() + held,
            p.escrowed,
            "SP-11: totalEscrowed did not fall by the refunded pool"
        );
        eq(escrow.totalOwed(), p.owed + held, "SP-11: totalOwed did not rise by the refunded pool");
        eq(address(escrow).balance, p.bal, "SP-11: refund moved ETH");
        eq(
            escrow.totalLmsEscrowed() + m.discLms,
            p.lmsEsc,
            "SP-11: totalLmsEscrowed did not fall by the match's LMS"
        );
        eq(
            lms.balanceOf(address(escrow)) + m.discLms,
            p.lmsEscBal,
            "SP-11: escrow LMS did not fall by the match's LMS"
        );
        eq(lms.totalSupply(), p.lmsSupply, "SP-11: a refund burned LMS");
        for (uint256 k; k < p.who.length; ++k) {
            (bool seated, uint256 ethOff, uint256 lmsPaid) = _spSeat(m, p.who[k]);
            uint256 credit = seated ? uint256(m.info.stake) - ethOff : 0;
            eq(
                escrow.withdrawable(p.who[k]),
                p.w[k] + credit,
                "SP-11: a seat was not credited stake - discount"
            );
            // The escrow can be a known address too, and the LMS it refunds leaves it: checked above.
            if (p.who[k] != address(escrow)) {
                eq(
                    lms.balanceOf(p.who[k]),
                    p.lmsBal[k] + (seated ? lmsPaid : 0),
                    "SP-11: a seat did not get its LMS back"
                );
            }
            eq(escrow.feesPaid(p.who[k], p.epoch), p.fees[k], "SP-10: a refund path changed feesPaid");
        }
        eq(escrow.epochFees(p.epoch), p.epochFees, "SP-10: a refund path changed epochFees");
    }

    // ─── SP-13: withdrawals ───

    /// @notice SP-13: a withdrawal pays exactly the balance, to the recipient, and moves nothing else
    function property_withdrawExact(
        SpPre memory p,
        address account,
        address to,
        uint256 amountBefore,
        uint256 got,
        uint256 toBalBefore
    ) internal {
        eq(got, amountBefore, "SP-13: returned amount differs from the balance");
        eq(escrow.withdrawable(account), 0, "SP-13: balance not zeroed");
        eq(escrow.totalOwed() + got, p.owed, "SP-13: totalOwed did not fall by the amount");
        eq(address(escrow).balance + got, p.bal, "SP-13: escrow ETH did not fall by the amount");
        eq(escrow.totalEscrowed(), p.escrowed, "SP-13: a withdrawal changed totalEscrowed");
        for (uint256 i; i < p.who.length; ++i) {
            if (p.who[i] != account) {
                eq(escrow.withdrawable(p.who[i]), p.w[i], "SP-13: a withdrawal changed another balance");
            }
        }
        if (to != address(escrow)) {
            eq(to.balance, toBalBefore + got, "SP-13: recipient did not receive the amount");
        }
    }

    // ─── SP-15: pause transitions ───

    /// @notice SP-15: guardian pause respects the cooldown, lasts GUARDIAN_PAUSE and clears the governance flag
    function property_guardianPause(uint64 untilBefore) internal {
        t(
            untilBefore == 0 || block.timestamp >= uint256(untilBefore) + escrow.GUARDIAN_COOLDOWN(),
            "SP-15: guardian paused inside its cooldown"
        );
        eq(
            uint256(escrow.pausedUntil()),
            block.timestamp + escrow.GUARDIAN_PAUSE(),
            "SP-15: pause is not now + GUARDIAN_PAUSE"
        );
        t(!escrow.pausedByGovernance(), "SP-15: guardian pause left the governance flag set");
        gte(
            uint256(escrow.pausedUntil()),
            uint256(untilBefore),
            "SP-15: guardian pause shortened a running pause"
        );
    }

    /// @notice SP-15: extendPause strictly raises pausedUntil and marks the pause governance's
    function property_extendPause(uint64 untilBefore, uint64 until) internal {
        eq(uint256(escrow.pausedUntil()), uint256(until), "SP-15: extendPause did not set the requested time");
        gt(uint256(until), uint256(untilBefore), "SP-15: extendPause did not raise pausedUntil");
        t(escrow.pausedByGovernance(), "SP-15: extendPause did not mark the pause as governance's");
    }

    /// @notice SP-15: unpause sets pausedUntil to now, and a guardian never lifts a governance pause
    function property_unpause(bool byGuardian, bool governanceBefore) internal {
        eq(uint256(escrow.pausedUntil()), block.timestamp, "SP-15: unpause did not set pausedUntil to now");
        t(!escrow.paused(), "SP-15: still paused after unpause");
        if (byGuardian) {
            t(
                !governanceBefore || config.guardian() == config.owner(),
                "SP-15: a guardian lifted a governance pause"
            );
        }
    }

    // ─── SP-16: disputes ───

    /// @notice SP-16: the first dispute extends the deadline once; a seat disputes once, inside the window
    function property_disputeTransitions(GameEscrow.MatchInfo memory before_, bytes32 id, address disputer)
        internal
    {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        eq(uint256(a.status), uint256(GameEscrow.MatchStatus.Proposed), "SP-16: dispute changed the status");
        t(block.timestamp < before_.deadline, "SP-16: a dispute was accepted at or after the deadline");
        t(escrow.hasSeat(id, disputer), "SP-16: an unseated caller disputed");
        t(!spDisputedBy[id][disputer], "SP-16: a seat disputed twice");
        spDisputedBy[id][disputer] = true;
        t(a.disputed, "SP-16: dispute did not set disputed");
        if (!before_.disputed) {
            eq(
                uint256(a.deadline),
                uint256(before_.deadline) + DISPUTE_EXTENSION,
                "SP-16: first dispute did not add DISPUTE_EXTENSION"
            );
        } else {
            eq(uint256(a.deadline), uint256(before_.deadline), "SP-16: a further dispute moved the deadline");
        }
    }

    /// @notice SP-16: dismiss restores max(deadline - DISPUTE_EXTENSION, now), only after a dispute, inside the window
    function property_dismissTransitions(GameEscrow.MatchInfo memory before_, bytes32 id) internal {
        GameEscrow.MatchInfo memory a = escrow.getMatch(id);
        t(before_.disputed, "SP-16: dismiss succeeded without a dispute");
        t(block.timestamp < before_.deadline, "SP-16: dismiss accepted at or after the deadline");
        eq(uint256(a.status), uint256(GameEscrow.MatchStatus.Proposed), "SP-16: dismiss changed the status");
        t(!a.disputed, "SP-16: dismiss left disputed set");
        uint256 restored = uint256(before_.deadline) - DISPUTE_EXTENSION;
        eq(
            uint256(a.deadline),
            restored > block.timestamp ? restored : block.timestamp,
            "SP-16: dismissed deadline is not max(d - EXT, now)"
        );
    }

    // ─── SP-17 / SP-18 / SP-19: bridge ───

    struct SpBridge {
        SpPre p;
        bool routable;
        bool canSeat;
        bytes32 id;
        address player;
        uint32 origin;
        uint256 wPlayer;
        uint256 stake;
        uint16 seatsBefore;
        uint256 recvEth;
        uint256 recvWeth;
    }

    function _spBridgePre(address token, uint256 amount, bytes memory message)
        internal
        view
        returns (SpBridge memory b)
    {
        b.p = _spPre(address(0));
        b.recvEth = address(bridgeReceiver).balance;
        b.recvWeth = weth.balanceOf(address(bridgeReceiver));
        if (token != address(weth)) return b;
        try bridgeReceiver.decodeJoin(message) returns (bytes32 id, address player, uint32 origin) {
            if (player == address(0)) return b;
            b.routable = true;
            b.id = id;
            b.player = player;
            b.origin = origin;
            b.wPlayer = escrow.withdrawable(player);
            GameEscrow.MatchInfo memory info = escrow.getMatch(id);
            b.stake = info.stake;
            b.seatsBefore = info.seatCount;
            b.canSeat = !escrow.paused() && info.status == GameEscrow.MatchStatus.Open
                && block.timestamp < info.joinDeadline && info.seatCount < info.maxSeats
                && !escrow.hasSeat(id, player) && amount >= info.stake
                && (!info.matchmade || escrow.rostered(id, player));
        } catch {}
    }

    /// @notice SP-17 / SP-18: a fill of WETH never loses or mints a wei, and the receiver keeps nothing it routed
    function property_bridgeJoinConserves(SpBridge memory b, uint256 amount) internal {
        // SP-18: escrow ETH + receiver ETH + receiver WETH rises by exactly what the pool delivered.
        eq(
            address(escrow).balance + address(bridgeReceiver).balance
                + weth.balanceOf(address(bridgeReceiver)),
            b.p.bal + b.recvEth + b.recvWeth + amount,
            "SP-18: a WETH fill did not add exactly its amount to escrow + receiver holdings"
        );
        if (!b.routable) return;
        eq(address(escrow).balance, b.p.bal + amount, "SP-17: escrow ETH did not rise by msg.value");
        eq(address(bridgeReceiver).balance, b.recvEth, "SP-17: receiver kept ETH from a routed fill");
        eq(
            weth.balanceOf(address(bridgeReceiver)),
            b.recvWeth,
            "SP-17: receiver kept WETH from a routed fill"
        );
        GameEscrow.MatchInfo memory a = escrow.getMatch(b.id);
        eq(
            escrow.totalOwed(),
            b.p.owed + (b.canSeat ? amount - b.stake : amount),
            "SP-17: totalOwed moved by the wrong amount"
        );
        eq(
            escrow.withdrawable(b.player),
            b.wPlayer + (b.canSeat ? amount - b.stake : amount),
            "SP-17: player credit is wrong"
        );
        if (b.canSeat) {
            eq(uint256(a.seatCount), uint256(b.seatsBefore) + 1, "SP-17: a seatable fill did not seat");
            t(escrow.hasSeat(b.id, b.player), "SP-17: the player has no seat");
            eq(
                escrow.totalEscrowed(),
                b.p.escrowed + b.stake,
                "SP-17: totalEscrowed did not rise by the stake"
            );
            eq(
                uint256(escrow.seatOrigin(b.id, b.player)),
                uint256(b.origin),
                "SP-17: seatOrigin differs from the message"
            );
        } else {
            eq(uint256(a.seatCount), uint256(b.seatsBefore), "SP-17: an unseatable fill seated someone");
            eq(escrow.totalEscrowed(), b.p.escrowed, "SP-17: an unseatable fill changed totalEscrowed");
        }
    }

    struct SpOut {
        SpPre p;
        uint256 amount;
        uint256 poolWeth;
        uint256 recvEth;
        uint256[] nonces; // aligned with signerActors
    }

    function _spOutPre(address player) internal view returns (SpOut memory o) {
        o.p = _spPre(address(0));
        o.amount = escrow.withdrawable(player);
        o.poolWeth = weth.balanceOf(address(acrossPool));
        o.recvEth = address(bridgeReceiver).balance;
        o.nonces = new uint256[](signerActors.length);
        for (uint256 i; i < signerActors.length; ++i) {
            o.nonces[i] = bridgeReceiver.nonces(signerActors[i]);
        }
    }

    /// @notice SP-19: a signed bridge-out empties the player's balance into the SpokePool and spends one nonce
    function property_bridgeWithdrawOut(
        SpOut memory o,
        BridgeJoinReceiver.Withdrawal memory w,
        BridgeJoinReceiver.Quote memory q
    ) internal {
        for (uint256 i; i < signerActors.length; ++i) {
            uint256 expectedNonce = o.nonces[i] + (signerActors[i] == w.player ? 1 : 0);
            eq(
                bridgeReceiver.nonces(signerActors[i]),
                expectedNonce,
                "SP-19: a nonce other than the player's moved, or the player's did not rise by one"
            );
        }
        eq(escrow.withdrawable(w.player), 0, "SP-19: player balance not emptied");
        eq(escrow.totalOwed() + o.amount, o.p.owed, "SP-19: totalOwed did not fall by the amount");
        eq(address(escrow).balance + o.amount, o.p.bal, "SP-19: escrow ETH did not fall by the amount");
        eq(escrow.totalEscrowed(), o.p.escrowed, "SP-19: bridge-out changed totalEscrowed");
        eq(
            weth.balanceOf(address(acrossPool)),
            o.poolWeth + o.amount,
            "SP-19: SpokePool did not receive the amount"
        );
        eq(address(bridgeReceiver).balance, o.recvEth, "SP-19: receiver ETH changed");
        gte(o.amount, escrow.MIN_WITHDRAW_FOR(), "SP-19: bridged below MIN_WITHDRAW_FOR");
        lte(q.outputAmount, o.amount, "SP-19: output above input");
        lte(o.amount - q.outputAmount, w.maxFee, "SP-19: fee above the signed maxFee");
    }

    // ─── SP-20 .. SP-26: staking, rewards stream, sweeps, harvest ───

    struct SpStake {
        uint256 supply;
        uint256 unstaking;
        uint256 lmsVault;
        uint256 vaultEth;
        uint256 rps;
        uint256 rate;
        uint256 finish;
        uint256 last;
        address[] who;
        uint256[] earned;
        uint256[] unstakeAssets;
        uint256[] unstakeUnlock;
    }

    uint256 private constant SP_NO_READ = type(uint256).max;

    function _spEarned(address a) private view returns (uint256) {
        try stakedLms.earned(a) returns (uint256 v) {
            return v;
        } catch {
            return SP_NO_READ;
        }
    }

    function _spStake() internal view returns (SpStake memory s) {
        s.supply = stakedLms.totalSupply();
        s.unstaking = stakedLms.totalUnstaking();
        s.lmsVault = lms.balanceOf(address(stakedLms));
        s.vaultEth = address(stakedLms).balance;
        s.rps = stakedLms.rewardPerShare();
        s.rate = stakedLms.rewardRate();
        s.finish = stakedLms.periodFinish();
        s.last = stakedLms.lastAccrual();
        s.who = _spWho(address(0));
        uint256 n = s.who.length;
        s.earned = new uint256[](n);
        s.unstakeAssets = new uint256[](n);
        s.unstakeUnlock = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            s.earned[i] = _spEarned(s.who[i]);
            (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(s.who[i]);
            s.unstakeAssets[i] = assets;
            s.unstakeUnlock[i] = unlockAt;
        }
    }

    /// @notice SP-20 / SP-37: no stake-moving call changes anyone's earned() (bar the claimer's), or anyone
    ///         else's pending unstake
    function property_stakingNeutral(SpStake memory s, address exceptEarned, address exceptUnstake) internal {
        for (uint256 i; i < s.who.length; ++i) {
            if (s.who[i] != exceptEarned && s.earned[i] != SP_NO_READ) {
                eq(_spEarned(s.who[i]), s.earned[i], "SP-20: a stake-moving call changed an earned() balance");
            }
            if (s.who[i] != exceptUnstake) {
                (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(s.who[i]);
                eq(
                    uint256(assets),
                    s.unstakeAssets[i],
                    "SP-37: a third party's pending unstake amount changed"
                );
                eq(uint256(unlockAt), s.unstakeUnlock[i], "SP-37: a third party's unlock time changed");
            }
        }
    }

    /// @notice SP-21 / SP-24: deposit mints 1:1 from the payer; with nothing staked the stream pauses
    function property_stakeDeposit(
        SpStake memory s,
        address payer,
        address account,
        uint256 amount,
        uint256 payerLmsBefore,
        uint256 accountBefore
    ) internal {
        eq(
            stakedLms.balanceOf(account),
            accountBefore + amount,
            "SP-21: sLMS minted is not the LMS deposited"
        );
        eq(stakedLms.totalSupply(), s.supply + amount, "SP-21: totalSupply did not rise by the deposit");
        eq(lms.balanceOf(payer) + amount, payerLmsBefore, "SP-21: payer LMS did not fall by the deposit");
        eq(
            lms.balanceOf(address(stakedLms)),
            s.lmsVault + amount,
            "SP-21: vault LMS did not rise by the deposit"
        );
        eq(stakedLms.totalUnstaking(), s.unstaking, "SP-21: a deposit changed totalUnstaking");
        property_stakingNeutral(s, address(0), address(0));
        if (s.supply == 0 && s.last < s.finish) {
            eq(
                stakedLms.periodFinish() - stakedLms.lastAccrual(),
                s.finish - s.last,
                "SP-24: the empty-vault stream did not pause"
            );
            eq(stakedLms.rewardPerShare(), s.rps, "SP-24: rewardPerShare moved with nothing staked");
        }
    }

    /// @notice SP-21: requestUnstake burns sLMS 1:1 into a pending claim that unlocks after the cooldown
    function property_requestUnstake(
        SpStake memory s,
        address account,
        uint256 amount,
        uint256 sBefore,
        uint256 assetsBefore
    ) internal {
        eq(stakedLms.balanceOf(account) + amount, sBefore, "SP-21: sLMS burned is not the amount requested");
        eq(stakedLms.totalSupply() + amount, s.supply, "SP-21: totalSupply did not fall by the amount");
        eq(
            stakedLms.totalUnstaking(),
            s.unstaking + amount,
            "SP-21: totalUnstaking did not rise by the amount"
        );
        (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(account);
        eq(uint256(assets), assetsBefore + amount, "SP-21: pending assets did not rise by the amount");
        eq(uint256(unlockAt), block.timestamp + stakedLms.cooldown(), "SP-21: unlockAt is not now + cooldown");
        eq(
            stakedLms.totalSupply() + stakedLms.totalUnstaking(),
            s.supply + s.unstaking,
            "SP-21: supply + unstaking changed"
        );
        eq(lms.balanceOf(address(stakedLms)), s.lmsVault, "SP-21: requestUnstake moved LMS");
        property_stakingNeutral(s, address(0), account);
        // SP-22 (EXPLORATORY, left unimplemented): a second request restarts unlockAt for the whole
        // pending amount at the current cooldown, so after a cooldown cut it shortens an earlier wait.
        // Asserting `unlockAt >= unlockAtBefore` is expected to fail by design; kept as a lead, not a check.
    }

    /// @notice SP-21: claim pays exactly the pending assets after the unlock, deletes the entry
    function property_claim(
        SpStake memory s,
        address claimer,
        address receiver,
        uint256 assets,
        uint256 unlockAt,
        uint256 receiverLmsBefore
    ) internal {
        t(block.timestamp >= unlockAt, "SP-21: claim succeeded before the unlock");
        (uint128 a2, uint64 u2) = stakedLms.unstakeOf(claimer);
        eq(uint256(a2) + uint256(u2), 0, "SP-21: claim did not delete the entry");
        eq(
            stakedLms.totalUnstaking() + assets,
            s.unstaking,
            "SP-21: totalUnstaking did not fall by the claim"
        );
        eq(
            lms.balanceOf(address(stakedLms)) + assets,
            s.lmsVault,
            "SP-21: vault LMS did not fall by the claim"
        );
        eq(lms.balanceOf(receiver), receiverLmsBefore + assets, "SP-21: receiver did not get the assets");
        eq(stakedLms.totalSupply(), s.supply, "SP-21: claim changed totalSupply");
        property_stakingNeutral(s, address(0), claimer);
    }

    /// @notice SP-20 / SP-23: depositRewards restarts the stream coherently and moves no one's earned()
    function property_depositRewards(SpStake memory s, uint256 value) internal {
        eq(address(stakedLms).balance, s.vaultEth + value, "SP-23: vault ETH did not rise by the deposit");
        eq(stakedLms.totalSupply(), s.supply, "SP-23: depositRewards changed totalSupply");
        eq(stakedLms.totalUnstaking(), s.unstaking, "SP-23: depositRewards changed totalUnstaking");
        property_stakingNeutral(s, address(0), address(0));
        eq(
            uint256(stakedLms.periodFinish()),
            block.timestamp + stakedLms.rewardDuration(),
            "SP-23: periodFinish is not now + rewardDuration"
        );
        eq(uint256(stakedLms.lastAccrual()), block.timestamp, "SP-23: lastAccrual is not now");
        eq(stakedLms.rewardPerShare(), s.rps, "SP-23: depositRewards moved rewardPerShare");
        if (s.supply != 0) {
            uint256 unpaid = block.timestamp < s.finish ? ((s.finish - block.timestamp) * s.rate) / 1e27 : 0;
            uint256 face = (stakedLms.rewardRate() * stakedLms.rewardDuration()) / 1e27;
            gte(face + 1, value + unpaid, "SP-23: stream face value more than one wei under deposit + unpaid");
            lte(face, value + unpaid, "SP-23: stream face value above deposit + unpaid");
        }
    }

    /// @notice SP-20: claimRewards pays exactly earned(), zeroes it, and moves no one else's
    function property_claimRewards(SpStake memory s, address claimer, uint256 earnedBefore, uint256 got)
        internal
    {
        if (earnedBefore != SP_NO_READ) {
            eq(got, earnedBefore, "SP-20: claimRewards paid other than earned()");
        }
        eq(_spEarned(claimer), 0, "SP-20: earned() not zero after claiming");
        eq(address(stakedLms).balance + got, s.vaultEth, "SP-20: vault ETH did not fall by the claim");
        property_stakingNeutral(s, claimer, address(0));
    }

    /// @notice SP-25: sweepStray removes exactly the LMS nobody is owed
    function property_sweepStray(SpStake memory s, address to, uint256 swept, uint256 toLmsBefore) internal {
        eq(swept, s.lmsVault - s.supply - s.unstaking, "SP-25: swept amount is not the surplus");
        eq(
            lms.balanceOf(address(stakedLms)),
            s.supply + s.unstaking,
            "SP-25: vault does not hold exactly supply + unstaking"
        );
        eq(lms.balanceOf(to), toLmsBefore + swept, "SP-25: recipient did not gain the amount");
    }

    /// @notice SP-26: harvest splits everything the router holds or is owed, and leaves nothing
    function property_harvestSplit(
        SpPre memory p,
        SpStake memory s,
        uint256 got,
        uint256 creditBefore,
        uint256 routerBalBefore,
        uint16 stakerBps,
        address treasury,
        uint256 treasuryEthBefore
    ) internal {
        uint256 total = creditBefore + routerBalBefore;
        eq(got, total, "SP-26: harvest returned other than credit + router balance");
        uint256 toStakers = (total * stakerBps) / BPS_DENOMINATOR;
        eq(
            address(stakedLms).balance,
            s.vaultEth + toStakers,
            "SP-26: vault did not get floor(A * bps / 1e4)"
        );
        if (treasury != address(stakedLms) && treasury != address(feeRouter)) {
            eq(
                treasury.balance,
                treasuryEthBefore + (total - toStakers),
                "SP-26: treasury did not get the rest"
            );
        }
        eq(address(feeRouter).balance, 0, "SP-26: router still holds ETH");
        eq(escrow.withdrawable(address(feeRouter)), 0, "SP-26: router still owed ETH");
        eq(escrow.totalOwed() + creditBefore, p.owed, "SP-26: totalOwed did not fall by the router's credit");
    }

    // ─── SP-28 / SP-29: play-mining claims and vesting ───

    struct SpClaim {
        uint256[] paid;
        bool[] claimed;
        uint256[] rate;
        uint256[] cap;
        uint256 granted;
        uint256 vestingLms;
        uint256 rewardsLms;
    }

    function _spClaimPre(address player, uint256[] memory epochs) internal view returns (SpClaim memory c) {
        c.paid = new uint256[](epochs.length);
        c.claimed = new bool[](epochs.length);
        c.rate = new uint256[](epochs.length);
        c.cap = new uint256[](epochs.length);
        for (uint256 i; i < epochs.length; ++i) {
            c.paid[i] = escrow.feesPaid(player, epochs[i]);
            c.claimed[i] = rewards.isClaimed(player, epochs[i]);
            (c.rate[i], c.cap[i],) = rewards.rateOf(epochs[i]);
        }
        c.granted = vesting.totalGranted();
        c.vestingLms = lms.balanceOf(address(vesting));
        c.rewardsLms = lms.balanceOf(address(rewards));
    }

    /// @notice SP-28: a claim grants exactly min(paid * rate / 1e18, cap) per epoch and moves that LMS to vesting
    function property_rewardsClaim(SpClaim memory c, address player, uint256[] memory epochs, uint256 reward)
        internal
    {
        t(block.timestamp < rewards.claimsCloseAt(), "SP-28: a claim succeeded after the window closed");
        uint256 expected;
        for (uint256 i; i < epochs.length; ++i) {
            t(
                block.timestamp >= rewards.claimableFrom(epochs[i]),
                "SP-28: a claim succeeded for an epoch that has not ended"
            );
            t(!c.claimed[i], "SP-28: a claim succeeded for an epoch already claimed");
            (,, bool fixedNow) = rewards.rateOf(epochs[i]);
            if (c.paid[i] == 0) {
                t(!rewards.isClaimed(player, epochs[i]), "SP-28: an epoch with no fees was marked claimed");
                continue;
            }
            t(rewards.isClaimed(player, epochs[i]), "SP-28: a paid epoch is not marked claimed");
            t(fixedNow, "SP-28: the epoch's rate was not fixed by the claim");
            uint256 scaled = (c.paid[i] * c.rate[i]) / 1e18;
            uint256 tranche = scaled < c.cap[i] ? scaled : c.cap[i];
            (uint128 amount,) = vesting.trancheOf(player, epochs[i]);
            eq(uint256(amount), tranche, "SP-28: tranche differs from min(paid * rate / 1e18, cap)");
            expected += tranche;
        }
        eq(reward, expected, "SP-28: reward returned differs from the sum of tranches");
        eq(vesting.totalGranted(), c.granted + reward, "SP-28: totalGranted did not rise by the reward");
        eq(
            lms.balanceOf(address(vesting)),
            c.vestingLms + reward,
            "SP-28: vesting LMS did not rise by the reward"
        );
        eq(
            lms.balanceOf(address(rewards)) + reward,
            c.rewardsLms,
            "SP-28: distributor LMS did not fall by the reward"
        );
    }

    /// @notice SP-29: release pays only vested LMS to the player, once
    function property_vestingRelease(
        address player,
        address caller,
        uint256[] memory epochs,
        uint256 expected,
        uint256 got,
        uint256 playerLmsBefore,
        uint256 callerLmsBefore,
        uint256 vestingLmsBefore,
        uint256 releasedBefore
    ) internal {
        eq(got, expected, "SP-29: released amount differs from the sum of releasable");
        eq(vesting.totalReleased(), releasedBefore + got, "SP-29: totalReleased did not rise by the amount");
        eq(
            lms.balanceOf(address(vesting)) + got,
            vestingLmsBefore,
            "SP-29: vesting LMS did not fall by the amount"
        );
        if (player != address(vesting)) {
            eq(lms.balanceOf(player), playerLmsBefore + got, "SP-29: the player did not receive the amount");
        }
        if (caller != player) {
            eq(lms.balanceOf(caller), callerLmsBefore, "SP-29: a third-party caller's LMS changed");
        }
        for (uint256 i; i < epochs.length; ++i) {
            eq(
                vesting.releasable(player, epochs[i]),
                0,
                "SP-29: something is still releasable at the same instant"
            );
            (uint128 amount, uint128 released) = vesting.trancheOf(player, epochs[i]);
            if (block.timestamp >= vesting.vestingStart(epochs[i]) + vesting.VESTING_DURATION()) {
                eq(
                    uint256(released),
                    uint256(amount),
                    "SP-29: a fully vested tranche was not released in full"
                );
            }
        }
        // The handler is already pranking `caller`.
        try vesting.release(player, epochs) {
            t(false, "SP-29: a second release at the same instant succeeded");
        } catch {}
    }

    /// @notice SP-29 helper: what a release would pay now, each distinct epoch once
    function _spReleasable(address player, uint256[] memory epochs) internal view returns (uint256 total) {
        for (uint256 i; i < epochs.length; ++i) {
            bool seen;
            for (uint256 j; j < i; ++j) {
                if (epochs[j] == epochs[i]) seen = true;
            }
            if (!seen) total += vesting.releasable(player, epochs[i]);
        }
    }

    // ─── SP-35: access control from an address with no role ───

    function _spDenied(address target, bytes memory data, string memory what) private {
        vm.prank(outsider);
        (bool ok,) = target.call(data);
        if (ok) t(false, what);
    }

    /// @notice SP-35: no privileged function succeeds for an address holding no role
    function property_accessControlMatrix(bytes32 someMatch) internal {
        ProtocolConfig.Params memory prm = config.getParams();
        address[] memory attestors = new address[](1);
        attestors[0] = attestorPool[0];
        uint16[] memory sched = config.getPayoutSchedule();
        string memory w = "SP-35: a privileged function succeeded for an unprivileged caller";

        _spDenied(address(config), abi.encodeCall(config.setParams, (prm)), w);
        _spDenied(address(config), abi.encodeCall(config.setRulesHash, (bytes32(uint256(1)))), w);
        _spDenied(address(config), abi.encodeCall(config.setPayoutSchedule, (sched)), w);
        _spDenied(address(config), abi.encodeCall(config.setRandomnessOracle, (address(vrf))), w);
        _spDenied(address(config), abi.encodeCall(config.setAttestorSet, (attestors, 1)), w);
        _spDenied(address(config), abi.encodeCall(config.setGuardian, (outsider)), w);
        _spDenied(address(config), abi.encodeCall(config.setChallengeWindow, (uint64(1 hours))), w);
        _spDenied(address(config), abi.encodeCall(config.setSequencerUptimeFeed, (address(0))), w);
        _spDenied(address(config), abi.encodeCall(config.setLmsToken, (outsider)), w);
        _spDenied(address(config), abi.encodeCall(config.setLmsPerEthDiscount, (1)), w);
        _spDenied(address(config), abi.encodeCall(config.setBridgeReceiver, (outsider)), w);
        _spDenied(address(config), abi.encodeCall(config.setMatchmaker, (outsider)), w);
        _spDenied(address(vrf), abi.encodeCall(vrf.setConsumer, (outsider, true)), w);
        _spDenied(
            address(bridgeReceiver), abi.encodeCall(bridgeReceiver.recover, (address(0), outsider, 0)), w
        );
        _spDenied(
            address(bridgeReceiver),
            abi.encodeCall(bridgeReceiver.handleV3AcrossMessage, (address(weth), 0, outsider, "")),
            w
        );
        _spDenied(address(stakedLms), abi.encodeCall(stakedLms.setCooldown, (uint64(2 days))), w);
        _spDenied(address(stakedLms), abi.encodeCall(stakedLms.sweepStray, (outsider)), w);
        _spDenied(address(feeRouter), abi.encodeCall(feeRouter.setTreasury, (outsider)), w);
        _spDenied(address(feeRouter), abi.encodeCall(feeRouter.setStakerBps, (uint16(0))), w);
        _spDenied(address(rewards), abi.encodeCall(rewards.setMaxRewardPerEth, (0)), w);
        _spDenied(address(rewards), abi.encodeCall(rewards.setMaxRewardPerWalletPerEpoch, (0)), w);
        _spDenied(address(rewards), abi.encodeCall(rewards.sweep, (outsider)), w);
        _spDenied(address(reserve), abi.encodeCall(reserve.setRecipient, (outsider, true)), w);
        _spDenied(address(reserve), abi.encodeCall(reserve.release, (outsider, 1)), w);
        _spDenied(
            address(vesting), abi.encodeCall(vesting.grant, (outsider, new uint256[](0), new uint256[](0))), w
        );
        _spDenied(address(governor), abi.encodeCall(governor.setQuorumFloor, (0)), w);
        _spDenied(address(zap), abi.encodeCall(zap.unlockCallback, ("")), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.extendPause, (uint64(block.timestamp + 1 days))), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.pause, ()), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.unpause, ()), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.veto, (someMatch)), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.dismissDispute, (someMatch)), w);
        _spDenied(
            address(escrow),
            abi.encodeCall(escrow.createMatchmade, (prm.minStake, prm.minSeats, new address[](0))),
            w
        );
        _spDenied(address(escrow), abi.encodeCall(escrow.bridgeJoin, (someMatch, outsider, 1)), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.withdrawToBridge, (actors[0])), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.fulfillRandomness, (someMatch, bytes32(0))), w);
        _spDenied(address(escrow), abi.encodeCall(escrow.withdrawFor, (actors[0])), w);
    }

    // ─── SP-30: ZapJoin ───

    /// @notice SP-30: a zap join moves exactly the stake from the pool manager into the escrow and keeps nothing
    function property_zapJoinConserves(
        SpPre memory p,
        uint256 poolManagerEthBefore,
        bytes32 id,
        address player,
        address tokenIn,
        uint256 tokenInBefore,
        uint256 maxAmountIn
    ) internal {
        uint256 stake = escrow.getMatch(id).stake;
        eq(escrow.totalEscrowed(), p.escrowed + stake, "SP-30: totalEscrowed did not rise by the stake");
        eq(address(escrow).balance, p.bal + stake, "SP-30: escrow ETH did not rise by the stake");
        eq(escrow.totalOwed(), p.owed, "SP-30: a zap join changed totalOwed");
        eq(
            address(poolManager).balance + stake,
            poolManagerEthBefore,
            "SP-30: pool manager ETH did not fall by the stake"
        );
        eq(address(zap).balance, 0, "SP-30: the zap contract holds ETH");
        eq(zapToken.balanceOf(address(zap)), 0, "SP-30: the zap contract holds a token");
        eq(zapTokenB.balanceOf(address(zap)), 0, "SP-30: the zap contract holds a token");
        t(escrow.hasSeat(id, player), "SP-30: the seat is not the caller's");
        uint256 tokenInAfter = ProjectMockERC20(tokenIn).balanceOf(player);
        lte(tokenInAfter, tokenInBefore, "SP-30: the caller's input token rose");
        lte(tokenInBefore - tokenInAfter, maxAmountIn, "SP-30: the caller paid more than maxAmountIn");
    }

    // ─── SP-32: session keys ───

    /// @notice SP-32: a grant stores exactly the caps given, nothing spent, inside the legal bounds
    function property_sessionGrant(
        address account,
        address key,
        uint48 validUntil,
        uint128 valueCap,
        uint128 spendCap
    ) internal {
        (uint48 v, uint128 vc, uint128 sc, uint128 spent) = SessionKeyDelegate(payable(account)).sessions(key);
        eq(uint256(v), uint256(validUntil), "SP-32: validUntil not stored as given");
        eq(uint256(vc), uint256(valueCap), "SP-32: valueCap not stored as given");
        eq(uint256(sc), uint256(spendCap), "SP-32: spendCap not stored as given");
        eq(uint256(spent), 0, "SP-32: a fresh grant has spent");
        t(
            validUntil > block.timestamp && validUntil <= block.timestamp + 7 days,
            "SP-32: grant outside (now, now + 7 days]"
        );
        t(valueCap <= spendCap, "SP-32: valueCap above spendCap");
    }

    /// @notice SP-32: revoke deletes the session
    function property_sessionRevoke(address account, address key) internal {
        (uint48 v, uint128 vc, uint128 sc, uint128 spent) = SessionKeyDelegate(payable(account)).sessions(key);
        eq(uint256(v) + uint256(vc) + uint256(sc) + uint256(spent), 0, "SP-32: revoke left a session behind");
    }

    function _spRecover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, v, r, s);
    }

    /// @notice SP-32: an executed session call spends exactly its value, inside the caps, on an allowed call
    function property_sessionExecuted(
        address account,
        address key,
        uint256 nonceBefore,
        uint256 spentBefore,
        address target,
        uint256 value,
        bytes memory data
    ) internal {
        SessionKeyDelegate a = SessionKeyDelegate(payable(account));
        eq(a.sessionNonce(), nonceBefore + 1, "SP-32: nonce did not rise by exactly one");
        (uint48 validUntil, uint128 valueCap, uint128 spendCap, uint128 spent) = a.sessions(key);
        eq(uint256(spent), spentBefore + value, "SP-32: spent did not rise by exactly the value");
        lte(value, uint256(valueCap), "SP-32: value above valueCap");
        lte(uint256(spent), uint256(spendCap), "SP-32: spent above spendCap");
        t(validUntil > block.timestamp, "SP-32: an expired session executed");
        t(
            target == address(escrow) && data.length == 36,
            "SP-32: a call outside the escrow, or with trailing bytes, executed"
        );
        bytes4 selector = bytes4(data);
        t(
            selector == GameEscrow.join.selector || (selector == escrow.withdrawFor.selector && value == 0),
            "SP-32: a selector other than join or withdrawFor executed"
        );
    }

    // ─── SP-34: reserve ───

    /// @notice SP-34: setRecipient never succeeds for the vault, the Safe, the reserve or zero
    function property_reserveSetRecipient(address recipient) internal {
        t(
            recipient != address(stakedLms) && recipient != safe && recipient != address(reserve)
                && recipient != address(0),
            "SP-34: setRecipient accepted a forbidden recipient"
        );
    }

    /// @notice SP-34: release moves exactly `amount` LMS from the reserve to an approved recipient
    function property_reserveRelease(
        address to,
        uint256 amount,
        bool approvedBefore,
        uint256 reserveBefore,
        uint256 toBefore
    ) internal {
        t(approvedBefore, "SP-34: released to a recipient that was not approved");
        eq(
            lms.balanceOf(address(reserve)) + amount,
            reserveBefore,
            "SP-34: reserve did not fall by exactly the amount"
        );
        if (to != address(reserve)) {
            eq(lms.balanceOf(to), toBefore + amount, "SP-34: recipient did not gain exactly the amount");
        }
        t(to != address(stakedLms), "SP-34: released to the vault");
    }
}
