// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {GameEscrow} from "./GameEscrow.sol";

/// @title MatchMarket
/// @notice Parimutuel spectator markets on a match's attested ranking.
///
/// @dev Two markets per match:
///        - Winner: bets on `ranking[0]`
///        - Top3:   bets on any of `ranking[0..2]` share the pot
///
///      Round-by-round elimination betting stays off-chain: it needs the
///      per-round history, which the escrow never sees. These markets only
///      need the finishing order, which settlement already commits to.
///
///      If a match is cancelled, or if nobody bet on a winning outcome,
///      every stake is refundable. Settlement is permissionless once the
///      escrow has a ranking.
contract MatchMarket is ReentrancyGuard {
    enum Kind {
        Winner,
        Top3
    }

    struct Book {
        uint256 total;
        uint256 winningStake;
        bool settled;
        bool aborted;
        mapping(address outcome => uint256) onOutcome;
        mapping(address better => mapping(address outcome => uint256)) stakeOf;
        mapping(address better => bool) claimed;
    }

    GameEscrow public immutable escrow;

    mapping(bytes32 matchId => mapping(Kind kind => Book)) private books;

    event BetPlaced(
        bytes32 indexed matchId, Kind indexed kind, address indexed better, address outcome, uint256 amount
    );
    event MarketSettled(bytes32 indexed matchId, Kind indexed kind, uint256 total, uint256 winningStake);
    event MarketAborted(bytes32 indexed matchId, Kind indexed kind);
    event Claimed(bytes32 indexed matchId, Kind indexed kind, address indexed better, uint256 amount);

    error ZeroBet();
    error UnknownMatch(bytes32 matchId);
    error BettingClosed(bytes32 matchId);
    error AlreadySettled(bytes32 matchId, Kind kind);
    error NotSettled(bytes32 matchId, Kind kind);
    error NothingToClaim();
    error TransferFailed(address to, uint256 amount);
    error MatchNotCancelled(bytes32 matchId);

    constructor(GameEscrow escrow_) {
        escrow = escrow_;
    }

    function place(bytes32 matchId, Kind kind, address outcome) external payable nonReentrant {
        if (msg.value == 0) revert ZeroBet();

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        if (info.status == GameEscrow.MatchStatus.None) revert UnknownMatch(matchId);
        if (
            info.status == GameEscrow.MatchStatus.Settled
                || info.status == GameEscrow.MatchStatus.Cancelled
        ) {
            revert BettingClosed(matchId);
        }

        Book storage book = books[matchId][kind];
        if (book.settled || book.aborted) revert BettingClosed(matchId);

        book.total += msg.value;
        book.onOutcome[outcome] += msg.value;
        book.stakeOf[msg.sender][outcome] += msg.value;

        emit BetPlaced(matchId, kind, msg.sender, outcome, msg.value);
    }

    /// @notice Locks the book against the escrow's attested ranking.
    function settle(bytes32 matchId, Kind kind) external nonReentrant {
        Book storage book = books[matchId][kind];
        if (book.settled || book.aborted) revert AlreadySettled(matchId, kind);

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        if (info.status != GameEscrow.MatchStatus.Settled) revert NotSettled(matchId, kind);

        address[] memory ranking = escrow.getRanking(matchId);
        uint256 winningStake;
        uint256 bound = kind == Kind.Winner ? 1 : 3;
        if (bound > ranking.length) bound = ranking.length;

        for (uint256 i = 0; i < bound; ++i) {
            winningStake += book.onOutcome[ranking[i]];
        }

        book.winningStake = winningStake;
        book.settled = true;

        // Empty book or no winning tickets: treat as a wash so funds are not stuck.
        if (book.total == 0 || winningStake == 0) {
            book.aborted = true;
            emit MarketAborted(matchId, kind);
            return;
        }

        emit MarketSettled(matchId, kind, book.total, winningStake);
    }

    /// @notice Opens refunds when the underlying match was cancelled.
    function abort(bytes32 matchId, Kind kind) external nonReentrant {
        Book storage book = books[matchId][kind];
        if (book.settled || book.aborted) revert AlreadySettled(matchId, kind);

        GameEscrow.MatchInfo memory info = escrow.getMatch(matchId);
        if (info.status != GameEscrow.MatchStatus.Cancelled) revert MatchNotCancelled(matchId);

        book.aborted = true;
        book.settled = true;
        emit MarketAborted(matchId, kind);
    }

    /// @notice Claims a win (or a refund if the book was aborted).
    /// @param outcomes Addresses this caller bet on; duplicates are ignored.
    function claim(bytes32 matchId, Kind kind, address[] calldata outcomes)
        external
        nonReentrant
        returns (uint256 amount)
    {
        Book storage book = books[matchId][kind];
        if (!book.settled) revert NotSettled(matchId, kind);
        if (book.claimed[msg.sender]) revert NothingToClaim();
        book.claimed[msg.sender] = true;

        if (book.aborted) {
            for (uint256 i = 0; i < outcomes.length; ++i) {
                amount += book.stakeOf[msg.sender][outcomes[i]];
                book.stakeOf[msg.sender][outcomes[i]] = 0;
            }
        } else {
            address[] memory ranking = escrow.getRanking(matchId);
            uint256 bound = kind == Kind.Winner ? 1 : 3;
            if (bound > ranking.length) bound = ranking.length;

            uint256 ticket;
            for (uint256 i = 0; i < outcomes.length; ++i) {
                address outcome = outcomes[i];
                if (!_isWinner(ranking, bound, outcome)) continue;
                ticket += book.stakeOf[msg.sender][outcome];
                book.stakeOf[msg.sender][outcome] = 0;
            }
            amount = (ticket * book.total) / book.winningStake;
        }

        if (amount == 0) revert NothingToClaim();

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed(msg.sender, amount);

        emit Claimed(matchId, kind, msg.sender, amount);
    }

    function getBook(bytes32 matchId, Kind kind)
        external
        view
        returns (uint256 total, uint256 winningStake, bool settled, bool aborted)
    {
        Book storage book = books[matchId][kind];
        return (book.total, book.winningStake, book.settled, book.aborted);
    }

    function stakeOf(bytes32 matchId, Kind kind, address better, address outcome)
        external
        view
        returns (uint256)
    {
        return books[matchId][kind].stakeOf[better][outcome];
    }

    function _isWinner(address[] memory ranking, uint256 bound, address outcome)
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < bound; ++i) {
            if (ranking[i] == outcome) return true;
        }
        return false;
    }
}
