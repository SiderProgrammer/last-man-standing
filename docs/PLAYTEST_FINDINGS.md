# Playtest findings — 11 Nov 2026

Played on the local rehearsal fork (`npm run fork:base`) at commit `80333aa`,
in browser tabs as P2–P5 with `npm run play` bots. Ticked UX proposals are implemented (12 Nov). Bugs: see "Where the bugs stand" below.

Covered: practice (3 and 7 bots), a private staked lobby, matchmaking, the
staked result and verification, Collect on Base and Collect to Arbitrum,
staking, unstaking, delegation, governance (vote, new proposal), joining with
USDC, staking from Arbitrum, an expired lobby cancelled and refunded, the
match history review, the phone layout.

Second pass: create-lobby input checks, two humans in one staked match, a
held move with the tab closed, reconnecting mid-match, dispute and guardian
veto, avatar mint on Base and Arbitrum, a short matchmade table (4 of 6),
the Reads tab, play-mining claim and release, the full governance cycle in
the UI (propose, vote, queue, execute: stakers' share is now 6000 on the
fork), withdrawing unstaked LMS, the guardian pause.

Third pass: an idle player in practice and in a staked match, two tabs on
one wallet, reloading mid-practice and while matched, a lobby with two
Arbitrum seats (via Across) and two Base seats, spectating live and
finished matches, keyboard play, the logged-out page, staking and
delegation inputs, and a probe of the server socket (malformed frames,
spam, practice-room flood).

Fourth pass: relay and withdrawal messages from a stranger, finalize and
collect from the review, a creator's own lobby, the proposal form's checks
for every action type, How to play, keyboard focus and labels, the light
colour scheme, the review screen, and forgetting the session key.

Fifth pass: Arbitrum and Base joins racing for the last seats, two browser
tabs racing for the last seat, a lobby whose randomness never arrives
(past its 1h timeout), the matchmaking queue across reloads and a closed
tab, and the Reads tab.

Sixth pass: replaying commits to the server, delegating votes and taking
them back, how disputes are offered, and the match, result and governance
screens at phone width (375 px) with 8 seats.

Not covered:

- **Blocked by the fork's warped clock:** one-click play turned on, the LMS
  fee discount, a successful LMS stake.
- **Not attempted:** a server restart mid-match (it needs a server source
  file saved), the analyst (no key on the server).

State left on the fork: chain time about 3 weeks ahead (5 Dec 2026), stakers'
share 6000, an empty 4-seat lobby opened by P8 (join window over), two
matches from the third pass in their challenge window (`0x3418…4b22`,
`0x0786…73d8`). The VRF responder is still not answering (bug 20).
After the fourth pass: both of those finalized (chain time moved 1h more),
P2's prize collected, an empty 4-seat lobby opened by P2 (`0x0f35…cb17`),
and P2's session key forgotten in the browser.
After the fifth pass: chain time moved 61 min more; `0x1a9a…63cf` (P2, P5,
P6, P7) stuck in "seeding" until its randomness timeout, then cancellable;
a matchmade table `0x8932…37f6` (P2 and three throwaway wallets, nobody
staked) that will expire; lobby `0xb7c5…9bf4` cancelled and refunded.

## Where the bugs stand (12 Nov)

Not replayed on the fork yet: these are fixed in code and covered by unit
tests, and the practice flows (reload, second tab, 8 seats at 375 px) were
checked in a browser against a local server.

- **Fixed by the UX work:** 1, 3, 4, 9, 16, 17, 31, 40, most of 44 (seats
  no longer overlap at 375 px; the end banner now fits the canvas too).
- **Fixed:**
  - 2, 14, 15, 36: the result panel reads the escrow: proposed (with the
    challenge countdown), disputed, settled, vetoed or cancelled; a collected
    prize says so; history rows are tagged "vetoed · refunded" or "disputed".
  - 5: reverts from any of our contracts decode to plain words
    (`contractErrorsAbi`, generated with the ABIs); a wallet cancel says so.
  - 6, 7, 39 (the clock part), 42: the server's bridge and the page count
    every deadline by the hub's block time, which the directory now carries.
    The permit and swap deadlines come from the latest block. A seeding table
    past its timeout offers "Cancel & refund".
  - 8: the replay label names the round being replayed; a page that attaches
    mid-hold gets `holdMs` and holds its clock instead of showing ~62 s.
  - 10: "Seat taken" counts seats from the join's own receipt.
  - 11, 43: bots retry a table the server does not know yet for two
    minutes; `play.mjs` stops waiting when a spoke stake is credited; the
    fork's Across relayer fills one deposit at a time, with retries.
  - 12: the proposal list asks the server's index to catch up
    (`/proposals?fresh=1`) right after proposing.
  - 13, 21: "Enter" on a table with no room stays in the lobby and says
    what it waits for; the match opens by itself when the room does.
  - 18: the escrow's pause is shown in the lobby, and blocks create, stake
    and the queue.
  - 19: a short matchmade table is opened with as many seats as players, so
    it locks the moment the last one stakes.
  - 20: the fork's VRF responder reads logs with its own cursor and times
    out a stuck send instead of stopping for good.
  - 22, 33: LMS amounts round to the nearest; dust reads "<0.01".
  - 23, 24, 27, 41: on every login the server re-sends the wallet's queue
    place, the table the queue put it at, and the match it is seated in
    (practice too); the queue belongs to the wallet, not to the socket that
    joined it.
  - 25: at most 6 practice matches per IP, and a practice room nobody has
    watched for a minute after its player left is closed.
  - 26: a practice match replaced from another tab tells that tab, which
    goes back to the lobby.
  - 28: the "Matched" toast has a "Go to the table" button.
  - 29: logged-out visitors get the lobby list; Stake reads "Connect to stake".
  - 30, 34: a spectator has no hold checkbox and no Collect; a table opened
    after it ended shows its history and winner.
  - 35: "Forget key" logs the socket out and asks the wallet for a new grant.
  - 37: the history no longer promises a replay.
  - 38: "Resume play" is refused while play is not paused (duplicates and a
    zero guardian were already refused).
- **Open, needs a decision:** 32 (an idle seat: auto-guard, or drop it after
  N missed rounds?) and 39 (should a player be able to leave an unfilled
  lobby?). Also 38's last point: "Protocol fee" still resends the whole
  `setParams` struct; only per-field setters in `ProtocolConfig` would stop
  one proposal undoing another.
- **Still to check:** 41's closed-tab case in a normal browser (the in-app
  browser may keep closed tabs' sockets open).

## Bugs

1. **"Your matches" does not update after a practice match.** The big
   "← Back to lobby" button (`dom.lockIn`, `leaveMatch` in `screens/match.ts`)
   skips the history refresh; only the result panel's back button triggers it
   (`screens/history.ts:27`). Staked matches show up anyway when they settle;
   practice matches do not until Refresh.
2. **Reviewing a collected match says the wrong things.** It says "It is in
   your balance: collect it below" after the prize was already collected
   (`ui/views.ts:311` reads the match status, not the balance). It also says
   "Proposed on-chain · winnings unlock once the challenge window closes" for
   a Settled match (`screens/result.ts:76` is hard-coded; `onReview` goes
   through it).
3. **Winnings does not redraw when a match settles or a lobby is cancelled.**
   The lobby kept showing "0 ETH · Nothing waiting" until a reload. Nothing
   polls it (staking and governance poll every 30 s).
4. **No pending prize in Winnings.** During the challenge window the lobby
   shows "0 ETH" and says nothing about the prize that is coming.
5. **Contract errors are not decoded.** Players see "The contract function
   depositWithPermit reverted", "joinWithToken reverted" and "custom error
   0x2def1a76" (`InvalidSession()`). Staking more LMS than you hold gives the
   same raw revert instead of "you hold 50,000 LMS".
6. **Signed deadlines use the browser clock.** The LMS permit
   (`wallet/permit.ts`, now + 10 min) and the token-join swap deadline
   (`screens/zap.ts`) come from `Date.now()`. On the warped fork, staking LMS,
   paying with USDC and the LMS discount all revert. On mainnet the same
   happens to anyone whose clock is off by more than ~10 min. Use the latest
   block's timestamp.
7. **Lobby close times and governance countdowns also use the browser
   clock.** On the Arbitrum tab, an Active proposal says "Voting opens in
   23h". An expired lobby never offers "Cancel & refund" (it still said
   "closes in 1d 1h").
8. **Wrong round number during the replay.** The panel says
   "ROUND 11 · REPLAY" while the arena banner says "ROUND 10". The timer
   shows ~62 s during the replay (replay plus the commit window).
9. **Phone layout overflows.** At 375 px the header is 605 px wide:
   Governance, the chain pill and the wallet button run off-screen and the
   page scrolls sideways.
10. **"Seat taken. The match starts when the lobby fills."** This toast
    appears even when your stake filled the lobby.
11. **The bot CLI gives up too early.** A bot that joins a matchmade lobby
    before the server's bridge tracks it gets `unknown match` (NOT_FOUND from
    `lobby.attach`). The bot runner treats that like a cancelled match, prints
    "the match was called off and refunded" and quits, so the seat sits idle.
12. **New proposals and new lobbies show up late.** After "Proposal created"
    the list still showed 1 proposal until the next 30 s poll. After
    "Lobby created" the lobby took ~10 s to appear.

### Second pass

13. **"Enter" on a lobby that is not full opens a dead-end match screen.**
    Black arena, "COMMIT", timer `--`, move buttons enabled, "Lock in" does
    nothing, no message and no way back except a reload. When the lobby
    fills and is seeded, the screen does come alive. Show "Waiting for 3 more
    players" with a way back, or keep Enter disabled until the room opens.
14. **A vetoed match still reads as a normal result.** History says
    "2nd of 4"; the review says "verified against chain · Proposed on-chain ·
    winnings unlock once the challenge window closes". Nothing mentions the
    veto or the refund.
15. **A disputed match does not say it is disputed.** The review says
    "Collectable once the challenge window closes, in 2d" with no mention of
    the dispute or the guardian.
16. **The result panel's Collect shows the whole balance under this match's
    prize.** "You won 0.00095 ETH" sits right above "Collect 0.0095 ETH" (an
    older balance). Label it "Collect your balance (0.0095 ETH)" or show it
    only when this match's prize is in it.
17. **Create-lobby validation leaks library errors.** Empty → "Value ``is
not a valid decimal number"; "-1" → "Number -1000000000000000000 is not
in safe 128-bit unsigned integer range"; 0, 0.0005 and 100000 → a bare`createMatch reverted` with no allowed range shown. "0,001" (Polish
    decimal comma) is rejected.
18. **Pause is invisible.** With the escrow paused the page does not say
    so; "Create lobby" fails with `createMatch reverted`, and matchmaking
    still puts you in the queue. (Collect still works, as designed.)
19. **A short matchmade table waits out the whole join window.** 4 of 6
    matched and all 4 staked, but the bridge locks only when a lobby is full
    or its window expires (`maybeLock` in `chain/bridge.ts`), so the players
    wait ~10 min for seats nobody else can take. Lock once the whole roster
    has staked. The row also says "3/6 · needs 1 more" for a 4-player roster.
20. **The fork's VRF responder stopped answering.** Two lobbies sat in
    "seeding" for minutes; the request was on-chain and a simulated fulfil
    succeeded, so the contracts were fine. I delivered both seeds by hand
    (impersonating the coordinator). The fork script's log was not visible
    to me, so the cause (watcher died, or a send hung with `busy` set) is a
    guess. Players see "seeding" forever with no timeout or refund hint.
    Third pass: two more requests went unanswered with blocks still being
    mined, so it is not waiting on confirmations; seeded by hand again.
21. **Live result stuck on "verified in your browser".** P2's result (the
    tab that went in through bug 13) never showed the on-chain check or the
    "Proposed on-chain" line; P3's did. May be tied to bug 13.
22. **Amounts are truncated, not rounded.** 0.99999 LMS shows as "0.99 LMS
    vesting"; 0.0000058 LMS shows as "0 LMS ready to release" while the
    Release button is visible (same as Claim ETH on dust).
23. **No auto-return to a running match after reconnecting.** The lobby
    shows the live match with "Enter"; it could take you straight back.

### Third pass

24. **A matched table is lost on reload.** The server sends `matched` once
    (`lobby/matchmaker.ts:149`) and the client keeps it only in memory
    (`app.matched`); `LobbyInfo` carries no roster. After a reload, a second
    tab or a dropped socket, your own table shows a disabled "Matchmade —
    only its players can take a seat", so you cannot stake and the table
    waits out its window and is cancelled. Staking the same seat from the
    CLI worked, so the contract's roster is fine. Send the roster with the
    lobby, or send `matched` again on login.
25. **One IP can fill the server's practice-room cap.** Each wallet may hold
    one practice room, wallets are free, and a room keeps running after its
    socket closes. A script logging in throwaway wallets from one IP opened
    198 rooms in about 2 minutes; after that every player got "the server is
    at its practice-room limit; try again shortly" (seen as P7). The rooms
    finished on their own and the cap cleared about 9 minutes later, so
    about 1 login a second keeps practice unavailable indefinitely.
    Possible fixes: a per-IP practice cap, and closing a practice room
    whose owner has had no socket for a minute.
26. **Starting practice in a second tab silently kills the first tab's
    match.** `createPractice` closes the wallet's previous room
    (`lobby/lobby.ts:188`) without telling its sockets. The first tab
    freezes at 0.0s with no message, only says "you are not in a live
    match" when you try to move, and has no way out but a reload.
27. **A practice match cannot be resumed after a reload.** The lobby comes
    back with no sign of it, while the room keeps running on the server with
    you idle (and holds one of the 200 practice slots).
28. **Matched while in practice, with no way to act on it.** A queued player
    who starts practice still gets matched. The toast "Matched: a 4-seat
    table is ready. Stake into 0x0786…73d8 to take your seat." appears, but
    the practice screen has no way back to the lobby, and reloading loses
    the table (bug 24).
29. **The logged-out page looks dead.** It says "No staked lobbies right
    now" while two are open, because the server sends the lobby list only
    to logged-in sockets. "Start practice match", "Find a match" and
    "Collect" look enabled but do nothing, with no "connect a wallet"
    prompt. A visitor without a wallet cannot try practice at all, though
    it "runs entirely off-chain".
30. **The spectator view is a player's view with the buttons greyed out.**
    The move panel and the "Reveal for me if I disconnect" checkbox (still
    clickable) are shown, and there is no "Stop watching" or Lobby button.
    Opening a match that has just ended shows "FINISHED", no winner, an
    empty History and the hint "Pick an action before the timer runs out."
    Watching to the end gives a result panel with "Collect 0.00228 ETH":
    that is the viewer's own older balance, but it equals this match's first
    prize, so it reads as if the spectator won (same cause as bug 16). The
    panel also has two "← Back to lobby" buttons.
31. **History lists each elimination twice.** "#0 → eliminated" (from
    `describeRound`) and then "eliminated: #0".
32. **Idle players.** A seat that never committed shows as "did not reveal"
    (it could say "no move"). The idle player gets no warning. In a staked
    match one idle seat makes every round run the full 60 s, with no
    penalty: 4 idle rounds in practice left the idle seat at 100 HP.
    How to play does say a missed timer means "no action" and that a match
    ends after 30 rounds, so one idle seat can stretch a staked match to
    about 30 minutes. Question for you: auto-guard, or drop a seat after N
    missed rounds?
33. **Unstake input messages.** Unstaking more than you have staked says
    "Enter how much LMS to unstake" instead of "You have 249,999 LMS
    staked"; "0,5" is rejected (same comma problem as bug 17).
34. **The end screen keeps the last sealed move.** "Sealed: strike #2" stays
    under "FINISHED" after the match is over.

### Fourth pass

35. **"Forget key" leaves you logged in but unable to move.** The socket
    stays logged in, so "Start practice match" (or entering a staked match)
    still works, but every move fails with "Log in to play: there is no
    session key to sign your move." The match screen has no Log in button,
    and the wallet button in the header does nothing. Forgetting the key
    during a staked match means missing every round. Log the socket out,
    or ask the wallet for a new grant straight away.
36. **Two screens disagree after a match is finalized** (more on bugs 2 and
    3). For over 45 s after finalize, the lobby's Winnings said "0 ETH ·
    Nothing waiting" while that match's review, on the same page, offered
    "Collect 0.00095 ETH". After collecting from the review, it still said
    "It is in your balance: collect it below or from the lobby".
37. **"Open one to replay its rounds" does not replay.** The review shows
    the final board and the list of rounds, with no way to step through
    them. Add a round slider, or change the wording.
38. **Proposal form gaps.**
    - The same action can be added any number of times (I added "Resume
      play" four times).
    - "Resume play" is offered while the escrow is not paused, so it would
      revert at execution.
    - The emergency guardian can be set to the zero address with no warning.
      The contract accepts it (`ProtocolConfig.sol:262`), which turns off
      the pause and the veto. The delegate form does warn about the zero
      address.
    - "Protocol fee per match" sends the whole `setParams` struct (seats,
      join window, stakes, treasury) as read when the form was opened. If
      another proposal changes one of those first, this one quietly sets it
      back. Voters see it only as one long raw struct.
39. **No way out of a lobby that does not fill** (design question). Once
    staked, a player can only get the stake back through `cancelMatch`
    after the join window (`GameEscrow.sol:824`), and the page does not
    offer that (bug 7). The join window on this deploy is 600 s, while the
    page says "closes in 23d" (bug 7's clock). Should players be able to
    leave an unfilled lobby?

### Fifth pass

40. **A reverted transaction is reported as a success.** `wallet.waitFor`
    (`wallet/wallet.ts:544`) returns the receipt without checking its status.
    P2 and P8 clicked Stake on the last seat of a lobby at the same moment.
    P2 got the seat; P8's join was mined and reverted (status 0, the lobby
    was full), yet P8's page said "Seat taken. The match starts when the
    lobby fills." Its row then said "Watch". Every flow that waits with
    `waitFor` (join, join with a token or LMS, cancel, collect, staking,
    votes, disputes) would report a revert the same way.
41. **The queue outlives the page.** After a reload the page shows "idle"
    and "Find a match" with no Leave queue button, while the server still
    has you queued (a fresh wallet saw 2 waiting). After I closed P2's only
    tab, P2 was still queued 95 s later and was put on the roster of a
    table formed about 3 minutes after the tab closed (`rostered` is true
    on-chain). The gateway is meant to drop a wallet from the queue when
    its last socket closes (`gateway/gateway.ts:735`), and my scripted
    sockets were dropped correctly, so the in-app browser may be keeping
    closed tabs' sockets open. Worth checking in a normal browser. The
    reload case (the page forgets, the server does not) stands either way.
42. **A lobby whose randomness never arrives gives no way out.** One hour
    after the request (`RANDOMNESS_TIMEOUT`) the row still says "seeding"
    with only "Enter"; no "Cancel & refund" is offered, though
    `cancelMatch` then works and refunds every seat (done from the CLI).
    "Enter" opens a black arena with "FINISHED · Match finished." and the
    History of a different match the tab had opened before.
43. **Fork tooling.**
    - Two Arbitrum stakes deposited in the same block: the fork's Across
      relayer filled one and dropped the other with no retry. A simulated
      fill of the dropped deposit succeeded, and filling it by hand
      credited P4 as expected.
    - `play.mjs join --from spoke` waits "in transit…" forever when the
      stake lands in a full lobby and is credited back (`play.mjs:346`).
      The page itself has a message for this case ("Not seated: … yours to
      collect").

### Sixth pass

44. **8 seats on a phone pile on top of each other.** At 375 px the eight
    avatars overlap so much that seat numbers, HP and the "locked in"
    captions are hidden under the next avatar. Strike still works through
    the list of target buttons (#1–#7) under the arena. The end banner
    "LAST ONE STANDING · SEAT #6" is cut off at both edges, and the page is
    510 px wide (bug 9). Governance fits at this width.

## Worked in the second pass

- A held move ("Reveal for me if I disconnect") counted after its tab closed.
- Reconnecting mid-match and playing on.
- Dispute, then guardian veto: Cancelled, every stake refunded.
- Avatar mint on Base and Arbitrum.
- Short matchmade table: opened ~15 s after 4 of 6 queued; payouts correct.
- Play-mining: 1 LMS claimed into vesting, part released.
- Governance in the UI: propose, vote, "Queue in timelock", "Execute".
- Withdraw after the unstake cooldown.
- Collect while the escrow is paused.

## Worked in the third pass

- The server socket: invalid JSON, a missing or unknown type, `__proto__`,
  moves while logged out, an oversized frame (closed with 1009), unknown
  match ids and unsupported queue tiers are all rejected cleanly. 60
  messages at once: 30 answered, then rate-limited, and the socket was
  closed after 20 strikes.
- A lobby with two Arbitrum seats (staked through Across) and two Base
  seats: the "BASE ×2 / ARB ×2" badges, play, and the result proposed
  on-chain.
- A staked match opens on its own in the seated player's tab once it is
  seeded.
- Keyboard play: 1/2/3 to pick, Enter to lock in.
- The staked result after playing: "verified against chain", place, prize
  and collect time.
- Delegation input checks (empty, not an address, the zero address).
- An unknown `?player=` falls back to "No EIP-1193 wallet found".

## Worked in the fourth pass

- Relay and withdrawal messages from a stranger's wallet: calls to anything
  but join and collect, another player's withdrawal, an unknown chain and a
  bad signature were all refused before any gas was spent.
- Finalize, then Collect from the match review ("Winnings collected.").
- Proposal checks: percentages, the 10% fee cap, 1–30 days, addresses;
  Cancel clears the form.
- How to play: clear rules, Esc closes it.
- Accessibility basics: every visible control has a name, no image lacks
  alt text, `lang="en"`, the keyboard focus ring shows.

## Worked in the fifth pass

- Arbitrum stakes that reach a full lobby are credited to the player's
  escrow balance (P3: 0.0105 → 0.0115 ETH), as the receiver promises.
- Two browser joins racing for one seat: exactly one seat taken on-chain.
- `cancelMatch` after the randomness timeout refunded all four seats.
- The Reads tab's counts match the match History.

## Worked in the sixth pass

- Replayed commits: refused with `STALE_MOVE`, one receipt only, nothing
  counted twice.
- Delegating to another wallet and "Back to me": both work, and the vote
  totals update on both wallets within a poll.
- Disputes are offered only when the in-browser check against the chain
  fails (not exercised: it needs a faked failure, and it downloads an
  evidence file).
