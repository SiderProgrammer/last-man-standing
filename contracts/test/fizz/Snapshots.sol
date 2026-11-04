// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Base} from "./Base.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {GameEscrow} from "../../src/GameEscrow.sol";
import {DISPUTE_EXTENSION} from "../../src/Constants.sol";

/// @notice Used to take snapshots of the state before and after a function call, and
///         to run the `_afterCall` hook that feeds the history-dependent global
///         properties (GL-05, 06, 09, 10, 11, 16, 20, 25, 27, 28, 30).
/// @dev No snapshot field reads an actor's ETH balance: under Medusa a pranked payable
///      call spends the harness's ETH, so it would be meaningless (see invariant-context.md).
///      Per-address arrays are indexed like `_known()` (actors first, then `extraAddrs`),
///      capped at 16; `knownAddrs[i]` names the address at index `i`.
abstract contract Snapshots is Base {
    uint256 internal constant SNAP_KNOWN = 16;

    struct State {
        // Which addresses the per-address arrays describe.
        uint256 knownCount;
        address[16] knownAddrs;
        // Escrow money.
        uint256 escrowBalance;
        uint256 totalOwed;
        uint256 totalEscrowed;
        uint256 totalLmsEscrowed;
        uint256 epochFeesNow;
        uint256[16] withdrawableOf;
        uint256[16] feesPaidOf;
        // LMS.
        uint256 lmsSupply;
        uint256 lmsBalEscrow;
        uint256 lmsBalVault;
        uint256 lmsBalVesting;
        uint256 lmsBalRewards;
        uint256 lmsBalReserve;
        uint256[16] lmsBalOf;
        // StakedLms.
        uint256 vaultEth;
        uint256 vaultSupply;
        uint256 totalUnstaking;
        uint256 rewardRate;
        uint64 periodFinish;
        uint64 lastAccrual;
        uint256 rps;
        uint256[16] earnedOf;
        uint256[16] unstakeAssets;
        uint64[16] unstakeUnlock;
        // FeeRouter.
        uint256 routerEth;
        uint256 routerCredit;
        uint16 routerStakerBps;
        uint256 treasuryEth;
        // Rewards and vesting.
        uint256 vestingGranted;
        uint256 vestingReleased;
        // Pause.
        uint64 pausedUntil;
        bool pausedByGov;
        // Bridge, zap.
        uint256 receiverEth;
        uint256 receiverWeth;
        uint256 poolMgrEth;
        uint256 acrossPoolWeth;
        uint256[3] bridgeNonceOf;
        // Sessions: index `account * 3 + key`.
        uint256[2] sessionNonce;
        uint256[6] sessionSpent;
        uint256[6] sessionValidUntil;
        // The touched match, filled only by `snapshotBefore(matchId)` / `snapshotAfter(matchId)`.
        bytes32 matchId;
        GameEscrow.MatchInfo matchInfo;
        uint128 matchDiscEth;
        uint128 matchDiscLms;
        address[] matchSeats;
        uint16 termsFeeBps;
        address termsTreasury;
        uint16[] termsPayoutBps;
    }

    State internal stateBefore;
    State internal stateAfter;

    function snapshotBefore() internal {
        _takeSnapshot(stateBefore);
    }

    function snapshotAfter() internal {
        _takeSnapshot(stateAfter);
    }

    /// @dev As `snapshotBefore()`, plus the match `id` (info, seats, discounts, terms).
    function snapshotBefore(bytes32 id) internal {
        _takeSnapshot(stateBefore);
        _takeMatch(stateBefore, id);
    }

    function snapshotAfter(bytes32 id) internal {
        _takeSnapshot(stateAfter);
        _takeMatch(stateAfter, id);
    }

    function _takeSnapshot(State storage s) private {
        _snapKnown(s);
        _snapEscrow(s);
        _snapLms(s);
        _snapVault(s);
        _snapMisc(s);
    }

    function _snapKnown(State storage s) private {
        address[] memory known = _known();
        uint256 n = known.length < SNAP_KNOWN ? known.length : SNAP_KNOWN;
        s.knownCount = n;
        uint256 epoch = block.timestamp / escrow.FEE_EPOCH();
        for (uint256 i = 0; i < n; ++i) {
            address a = known[i];
            s.knownAddrs[i] = a;
            s.withdrawableOf[i] = escrow.withdrawable(a);
            s.feesPaidOf[i] = escrow.feesPaid(a, epoch);
            s.lmsBalOf[i] = lms.balanceOf(a);
            s.earnedOf[i] = _earnedOrZero(a);
            (uint128 assets, uint64 unlockAt) = stakedLms.unstakeOf(a);
            s.unstakeAssets[i] = assets;
            s.unstakeUnlock[i] = unlockAt;
        }
        for (uint256 i = n; i < SNAP_KNOWN; ++i) {
            s.knownAddrs[i] = address(0);
            s.withdrawableOf[i] = 0;
            s.feesPaidOf[i] = 0;
            s.lmsBalOf[i] = 0;
            s.earnedOf[i] = 0;
            s.unstakeAssets[i] = 0;
            s.unstakeUnlock[i] = 0;
        }
    }

    function _snapEscrow(State storage s) private {
        s.escrowBalance = address(escrow).balance;
        s.totalOwed = escrow.totalOwed();
        s.totalEscrowed = escrow.totalEscrowed();
        s.totalLmsEscrowed = escrow.totalLmsEscrowed();
        s.epochFeesNow = escrow.epochFees(block.timestamp / escrow.FEE_EPOCH());
        s.pausedUntil = escrow.pausedUntil();
        s.pausedByGov = escrow.pausedByGovernance();
    }

    function _snapLms(State storage s) private {
        s.lmsSupply = lms.totalSupply();
        s.lmsBalEscrow = lms.balanceOf(address(escrow));
        s.lmsBalVault = lms.balanceOf(address(stakedLms));
        s.lmsBalVesting = lms.balanceOf(address(vesting));
        s.lmsBalRewards = lms.balanceOf(address(rewards));
        s.lmsBalReserve = lms.balanceOf(address(reserve));
        s.vestingGranted = vesting.totalGranted();
        s.vestingReleased = vesting.totalReleased();
    }

    function _snapVault(State storage s) private {
        s.vaultEth = address(stakedLms).balance;
        s.vaultSupply = stakedLms.totalSupply();
        s.totalUnstaking = stakedLms.totalUnstaking();
        s.rewardRate = stakedLms.rewardRate();
        s.periodFinish = stakedLms.periodFinish();
        s.lastAccrual = stakedLms.lastAccrual();
        s.rps = stakedLms.rewardPerShare();
        s.routerEth = address(feeRouter).balance;
        s.routerCredit = escrow.withdrawable(address(feeRouter));
        s.routerStakerBps = feeRouter.stakerBps();
        s.treasuryEth = feeRouter.treasury().balance;
    }

    function _snapMisc(State storage s) private {
        s.receiverEth = address(bridgeReceiver).balance;
        s.receiverWeth = weth.balanceOf(address(bridgeReceiver));
        s.poolMgrEth = address(poolManager).balance;
        s.acrossPoolWeth = weth.balanceOf(address(acrossPool));
        for (uint256 i = 0; i < 3; ++i) {
            s.bridgeNonceOf[i] = bridgeReceiver.nonces(signerActors[i]);
        }
        for (uint256 i = 0; i < 2; ++i) {
            s.sessionNonce[i] = sessionAccounts[i].sessionNonce();
            for (uint256 j = 0; j < 3; ++j) {
                (uint48 validUntil,,, uint128 spent) = sessionAccounts[i].sessions(sessionKeys[j]);
                s.sessionSpent[i * 3 + j] = spent;
                s.sessionValidUntil[i * 3 + j] = validUntil;
            }
        }
    }

    function _takeMatch(State storage s, bytes32 id) private {
        s.matchId = id;
        s.matchInfo = escrow.getMatch(id);
        address[] memory seats = escrow.getSeats(id);
        s.matchSeats = seats;
        uint128 ethOff;
        uint128 lmsPaid;
        for (uint256 i = 0; i < seats.length; ++i) {
            GameEscrow.Discount memory d = escrow.getSeatDiscount(id, seats[i]);
            ethOff += d.eth;
            lmsPaid += d.lms;
        }
        s.matchDiscEth = ethOff;
        s.matchDiscLms = lmsPaid;
        GameEscrow.Terms memory t = escrow.getMatchTerms(id);
        s.termsFeeBps = t.feeBps;
        s.termsTreasury = t.treasury;
        s.termsPayoutBps = t.payoutBps;
    }

    function _earnedOrZero(address account) internal view returns (uint256) {
        try stakedLms.earned(account) returns (uint256 e) {
            return e;
        } catch {
            return 0;
        }
    }

    // ――――――――――――――――――――――――― Hook ―――――――――――――――――――――――――――
    //
    // `_afterCall()` must run as the LAST line of every handler (after the protocol call
    // succeeded). It observes history that no single state read can show and sets bits of
    // `ghosts.violated`, which the GL properties assert. It never reverts and never
    // asserts itself.

    bytes32 private constant ROLE_PROPOSER = keccak256("PROPOSER_ROLE");
    bytes32 private constant ROLE_CANCELLER = keccak256("CANCELLER_ROLE");

    function _afterCall() internal {
        _trackMatches();
        _trackTerms();
        _freezeEpochs();
        _trackStaking();
        _trackRewards();
        _trackGovernance();
        _trackSessions();
        _trackConfig();
        _trackPhase();
    }

    // --- GL-05, GL-06, GL-11 -------------------------------------------------

    function _trackMatches() private {
        uint256 count = matchIds.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 id = matchIds[i];
            GameEscrow.MatchInfo memory m = escrow.getMatch(id);
            uint8 cur = uint8(m.status);
            uint8 prev = ghosts.lastStatus[id];
            if (cur != prev) {
                // Open..Proposed only move to a later status; Settled and Cancelled are absorbing.
                if (!(cur > prev && prev < 5)) ghosts.violated |= V_STATUS;
                ghosts.lastStatus[id] = cur;
            }
            if (cur == 0) continue;
            _trackRecord(id, m, cur);
            if (cur == 4) _trackDeadline(id, m);
        }
    }

    function _trackRecord(bytes32 id, GameEscrow.MatchInfo memory m, uint8 status) private {
        MatchRec storage r = ghosts.matchRec[id];
        if (!r.seen) {
            r.seen = true;
            r.stake = m.stake;
            r.termsId = m.termsId;
            r.maxSeats = m.maxSeats;
            r.matchmade = m.matchmade;
            r.joinDeadline = m.joinDeadline;
        } else if (
            r.stake != m.stake || r.termsId != m.termsId || r.maxSeats != m.maxSeats
                || r.matchmade != m.matchmade || r.joinDeadline != m.joinDeadline
        ) {
            ghosts.violated |= V_RECORD;
        }

        // Fixed at lock. A match cancelled out of Open never had them.
        if (r.lockedSeen) {
            if (r.oracle != m.oracle || r.attVer != m.attestorSetVersion) ghosts.violated |= V_RECORD;
        } else if (status >= 2 && status != 6) {
            r.lockedSeen = true;
            r.oracle = m.oracle;
            r.attVer = m.attestorSetVersion;
        }

        // The seed is zero until the match is Live, then fixed.
        if (status <= 2 && m.seed != bytes32(0)) ghosts.violated |= V_RECORD;
        if (r.liveSeen) {
            if (r.seed != m.seed) ghosts.violated |= V_RECORD;
        } else if (status >= 3 && status != 6) {
            r.liveSeen = true;
            r.seed = m.seed;
        }

        // The signed result is fixed once Proposed.
        if (r.proposedSeen) {
            if (
                r.rankingHash != m.rankingHash || r.historyRoot != m.historyRoot
                    || r.transcriptHash != m.transcriptHash || r.rounds != m.rounds
            ) ghosts.violated |= V_RECORD;
        } else if (status == 4 || status == 5) {
            r.proposedSeen = true;
            r.rankingHash = m.rankingHash;
            r.historyRoot = m.historyRoot;
            r.transcriptHash = m.transcriptHash;
            r.rounds = m.rounds;
        }

        // The roster is final once the lobby has closed.
        if (r.closedSeen) {
            if (r.seatCountAtClose != m.seatCount) ghosts.violated |= V_RECORD;
        } else if (status >= 2) {
            r.closedSeen = true;
            r.seatCountAtClose = m.seatCount;
        }

        // A terminal match never changes again: its info always, its seats and
        // discounts on a sample (they cost a call per seat).
        if (status >= 5) {
            bytes32 infoFp = keccak256(abi.encode(m));
            if (!r.hasFp) {
                r.hasFp = true;
                r.frozenFp = infoFp;
                r.frozenSeatsFp = _seatsFingerprint(id);
            } else {
                if (r.frozenFp != infoFp) ghosts.violated |= V_RECORD;
                if (uint256(keccak256(abi.encode(id, block.timestamp, block.number))) % 4 == 0) {
                    if (r.frozenSeatsFp != _seatsFingerprint(id)) ghosts.violated |= V_RECORD;
                }
            }
        }
    }

    function _seatsFingerprint(bytes32 id) private view returns (bytes32) {
        address[] memory seats = escrow.getSeats(id);
        GameEscrow.Discount[] memory discounts = new GameEscrow.Discount[](seats.length);
        for (uint256 i = 0; i < seats.length; ++i) {
            discounts[i] = escrow.getSeatDiscount(id, seats[i]);
        }
        return keccak256(abi.encode(seats, discounts));
    }

    /// @dev Records the deadline `settle` set, unless a handler did, and checks GL-11.
    function _trackDeadline(bytes32 id, GameEscrow.MatchInfo memory m) private {
        uint40 original = ghosts.originalDeadline[id];
        if (original == 0) {
            // First seen while disputed: the extension is outstanding, so take it off.
            original = m.disputed ? uint40(m.deadline - DISPUTE_EXTENSION) : m.deadline;
            ghosts.originalDeadline[id] = original;
        }
        if (uint256(m.deadline) > uint256(original) + DISPUTE_EXTENSION) ghosts.violated |= V_DEADLINE;
        if (!m.disputed && m.deadline < original) ghosts.violated |= V_DEADLINE;
    }

    // --- GL-06 (terms) ------------------------------------------------------

    function _trackTerms() private {
        uint32 count = escrow.termsCount();
        if (count < ghosts.lastTermsCount) ghosts.violated |= V_RECORD;
        for (uint32 t = 1; t <= count; ++t) {
            bytes32 h = keccak256(abi.encode(escrow.getTerms(t)));
            bytes32 seen = ghosts.termsHash[t];
            if (seen == bytes32(0)) ghosts.termsHash[t] = h;
            else if (seen != h) ghosts.violated |= V_RECORD;
        }
        if (count > ghosts.lastTermsCount) ghosts.lastTermsCount = count;
    }

    // --- GL-09, GL-10 -------------------------------------------------------

    function _freezeEpochs() private {
        uint256 length = feeEpochs.length;
        if (length == 0) return;
        uint256 span = escrow.FEE_EPOCH();
        address[] memory known = _known();
        for (uint256 i = 0; i < length; ++i) {
            uint256 e = feeEpochs[i];
            uint256 total = escrow.epochFees(e);
            if (total < ghosts.lastEpochFees[e]) ghosts.violated |= V_FEE_DOWN;
            else ghosts.lastEpochFees[e] = total;

            if (block.timestamp < (e + 1) * span) continue;
            // Ended: final from here on.
            if (!ghosts.frozenFlag[e]) {
                ghosts.frozenFlag[e] = true;
                ghosts.frozenEpochFees[e] = total;
            } else if (ghosts.frozenEpochFees[e] != total) {
                ghosts.violated |= V_EPOCH_FROZEN;
            }
            if (total == 0) continue;
            for (uint256 j = 0; j < known.length; ++j) {
                uint256 paid = escrow.feesPaid(known[j], e);
                if (!ghosts.frozenSeen[e][known[j]]) {
                    ghosts.frozenSeen[e][known[j]] = true;
                    ghosts.frozenFeesPaid[e][known[j]] = paid;
                } else if (ghosts.frozenFeesPaid[e][known[j]] != paid) {
                    ghosts.violated |= V_EPOCH_FROZEN;
                }
            }
        }
    }

    // --- GL-16 --------------------------------------------------------------

    function _trackStaking() private {
        uint256 rps = stakedLms.rewardPerShare();
        if (rps < ghosts.maxRps) ghosts.violated |= V_ACCUMULATOR;
        else ghosts.maxRps = rps;
        uint256 last = stakedLms.lastAccrual();
        if (last < ghosts.maxLastAccrual) ghosts.violated |= V_ACCUMULATOR;
        else ghosts.maxLastAccrual = last;
    }

    // --- GL-18 (tranches), GL-20 ---------------------------------------------

    function _trackRewards() private {
        uint256 length = feeEpochs.length;
        if (length == 0) return;
        uint256 first = rewards.firstEpoch();
        address[] memory known = _known();
        for (uint256 i = 0; i < length; ++i) {
            uint256 e = feeEpochs[i];
            // No tranche can exist in an epoch with no fees or before the program.
            if (e < first || escrow.epochFees(e) == 0) continue;

            (uint256 rate, uint256 walletCap, bool fixed_) = rewards.rateOf(e);
            if (ghosts.rateSeen[e]) {
                if (!fixed_ || rate != ghosts.rateRec[e] || walletCap != ghosts.capRec[e]) {
                    ghosts.violated |= V_REWARD_TERMS;
                }
            } else if (fixed_) {
                ghosts.rateSeen[e] = true;
                ghosts.rateRec[e] = rate;
                ghosts.capRec[e] = walletCap;
            }

            for (uint256 j = 0; j < known.length; ++j) {
                address a = known[j];
                bool claimed = rewards.isClaimed(a, e);
                if (ghosts.claimedSeen[a][e] && !claimed) ghosts.violated |= V_REWARD_TERMS;
                if (claimed) ghosts.claimedSeen[a][e] = true;

                (uint128 amount,) = vesting.trancheOf(a, e);
                uint256 recorded = ghosts.amtRec[a][e];
                if (recorded != 0 && amount != recorded) ghosts.violated |= V_REWARD_TERMS;
                if (amount != 0) {
                    ghosts.amtRec[a][e] = amount;
                    if (!claimed || !fixed_) ghosts.violated |= V_REWARD_TERMS;
                }
            }
        }
    }

    // --- GL-27 --------------------------------------------------------------

    function _trackGovernance() private {
        uint256 length = proposals.length;
        for (uint256 i = 0; i < length; ++i) {
            uint256 id = proposals[i].id;
            uint8 cur;
            try governor.state(id) returns (IGovernor.ProposalState st) {
                cur = uint8(st);
            } catch {
                continue;
            }
            uint8 last = ghosts.lastProposalState[id];
            if (cur != last && _proposalMoveIllegal(last, cur)) ghosts.violated |= V_PROPOSAL_STATE;
            ghosts.lastProposalState[id] = cur;
        }
    }

    /// @dev OZ ProposalState: 0 Pending, 1 Active, 2 Canceled, 3 Defeated, 4 Succeeded,
    ///      5 Queued, 6 Expired, 7 Executed. A new proposal is first seen at 0 (the zero default).
    function _proposalMoveIllegal(uint8 last, uint8 cur) private pure returns (bool) {
        // Canceled, Defeated, Expired and Executed are absorbing.
        if (last == 2 || last == 3 || last == 6 || last == 7) return true;
        if (last == 0) return false;
        if (last == 1) return cur == 0;
        // Succeeded or Queued: only forward, never back to voting or to Defeated.
        if (last == 4) return cur == 0 || cur == 1 || cur == 3;
        return cur != 2 && cur != 7 && cur != 6; // Queued
    }

    // --- GL-25 --------------------------------------------------------------

    function _trackSessions() private {
        for (uint256 i = 0; i < sessionAccounts.length; ++i) {
            uint256 nonce = sessionAccounts[i].sessionNonce();
            address account = address(sessionAccounts[i]);
            if (nonce < ghosts.maxNonce[account]) ghosts.violated |= V_SESSION;
            else ghosts.maxNonce[account] = nonce;
        }
    }

    // --- GL-30 --------------------------------------------------------------

    function _trackConfig() private {
        uint32 version = config.attestorSetVersion();
        if (version < ghosts.maxAttVer) ghosts.violated |= V_CONFIG;
        else ghosts.maxAttVer = version;
        for (uint32 v = 1; v <= version; ++v) {
            bytes32 h = keccak256(abi.encode(config.getAttestors(v)));
            uint32 th = config.thresholdOf(v);
            bytes32 seenHash = ghosts.setHash[v];
            if (seenHash == bytes32(0)) {
                ghosts.setHash[v] = h;
                ghosts.thAt[v] = th;
            } else if (seenHash != h || ghosts.thAt[v] != th) {
                ghosts.violated |= V_CONFIG;
            }
        }
        address token = config.lmsToken();
        if (ghosts.lmsTokenSeen == address(0)) ghosts.lmsTokenSeen = token;
        else if (token != ghosts.lmsTokenSeen) ghosts.violated |= V_CONFIG;
    }

    // --- GL-28 --------------------------------------------------------------

    function _trackPhase() private {
        bool proposer = timelock.hasRole(ROLE_PROPOSER, address(phase));
        bool canceller = timelock.hasRole(ROLE_CANCELLER, address(phase));
        if (proposer != canceller) {
            ghosts.violated |= V_PHASE;
        } else if (!proposer) {
            ghosts.phaseLostSeen = true;
            // Retiring needs the phase to be over.
            if (block.timestamp < phase.phaseEnd()) ghosts.violated |= V_PHASE;
        } else if (ghosts.phaseLostSeen) {
            ghosts.violated |= V_PHASE;
        }
    }
}
