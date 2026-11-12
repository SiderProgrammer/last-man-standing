# Playtest findings — 11 Nov 2026

Played on the local rehearsal fork (`npm run fork:base`) at commit `80333aa`,
in browser tabs as P2–P5 with `npm run play` bots. Ticked UX proposals are implemented (12 Nov); the bugs are not fixed yet.

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
17. **Create-lobby validation leaks library errors.** Empty → "Value `` is
    not a valid decimal number"; "-1" → "Number -1000000000000000000 is not
    in safe 128-bit unsigned integer range"; 0, 0.0005 and 100000 → a bare
    `createMatch reverted` with no allowed range shown. "0,001" (Polish
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

## UX proposals

Recommended order: group 1, then the end-of-match card and the reload login
from group 3, then the lobby layout (group 2, the biggest change).

### 1. Money clarity

- [x] **Show what you can win before you stake.** Lobby rows and matchmaking
      tables show only the stake. Add the pot and the top prize, e.g.
      "Pot 0.004 · 1st 0.00228" (same math as `prizeFor`).
- [x] **Winnings badge in the header**, e.g. "0.00095 ETH to collect", next to
      the wallet button; it opens Winnings. Pairs with bug 3.
- [x] **Pending prizes in Winnings** (bug 4), e.g. "0.00095 ETH unlocking in 42m".
- [x] **"Stakes & payouts" section in How to play.** It covers no fee, no
      60/25/15 split, no challenge window and nothing on collecting.

### 2. Lobby layout ("find a match / staked lobbies should have better UI")

The page is one column about 2,000 px tall; the account panels sit below the fold.

- [x] **Matchmaking as the main path.** It is the only one that earns LMS but
      gets the same weight as "Staked lobbies". Put "Find a match" first and
      full width; open lobbies and "Open your own lobby" below it.
- [x] **Move "Pay with" and "Pay part of the fee in LMS" into the join step.**
      Clicking Stake opens a payment choice, then a quote, then Pay. Global
      settings above an empty list read as clutter.
- [x] **Matched table state.** The matchmaking panel says "idle" and offers
      "Find a match" again while a matched table waits for your stake. Show
      "Table ready, stake to take your seat" and highlight that row.
- [x] **Create and stake in one click** ("Create & stake 0.001"). Today a new
      lobby opens at 0/4 and needs a second click.
- [x] **Default the stake box to the cheapest table** (0.001, not 0.01).
- [x] **Account screen.** Move staking, session key, one-click play and avatar
      off the play page, reached from the wallet button. Session key and
      one-click go under "Advanced".
- [x] **Phone header** (bug 9): fold the nav into a menu below ~600 px.

### 3. Match and result

- [x] **One clear end-of-match card.** The result sits below the arena, half
      off-screen. Show an overlay (or scroll to a card) with place, prize,
      "Collect" and "Back to lobby". Removes the duplicate back button and the
      leftover `--` timer.
- [x] **"Leave to lobby" once eliminated.** Today you can only spectate until
      the match ends; the header has no Lobby button during a match.
- [x] **Log back in on reload** when a stored session key exists. No prompt is
      needed; it matters mid-match with 60 s on the clock.
- [x] **Replay label** (bug 8): "Replaying round 10", and no timer until the
      commit window opens.
- [x] **8-seat crowding.** At narrow widths the "locked in" captions overlap
      the next seat's badge. Shrink them or hide the text at 8 seats.
- [x] **Scroll to the top when entering a match.** The lobby's scroll position
      carries over and the arena opens half off-screen.
- [x] **Damage in History**, e.g. "#0 → struck #1 (−25)". The feed lists only moves.

### 4. Staking and governance

- [x] **Warn before unstaking restarts the cooldown.** Unstaking 1 more LMS
      reset 50,000 LMS already unlocking from 9d 22h back to 10d, silently.
      "This restarts the 10-day cooldown for the 50,000 LMS already unlocking."
- [x] **Claim ETH on dust.** The pill rounds to "0 ETH earned" while the
      button stays visible and sends a transaction. Hide it below a threshold
      or show "<0.000001 ETH".
- [x] **Proposal form actions.** "Add at least one action" shows while the
      action fields are filled in, because "Add action" must be clicked
      first. Count the filled-in action on Submit.
- [x] **Wording:** "300,000 of 100,000 sLMS needed" → "You have 300,000 sLMS ·
      100,000 needed to propose"; "You voted" → "You voted Against" (and show
      the reason); "Voting costs gas on L1" → "on Base".
- [x] **New proposals and lobbies right away** (A new lobby shows as "opening…" at once; a new proposal gets a status line and extra refreshes. The server waits 3 confirmations, which on an idle anvil means until the next transactions.) (bug 12): show them as
      "creating…" until the next poll picks them up.

### Small polish

- [x] Success toasts use the red error border.
- [x] "Pay 0.001" needs a unit: "Pay 0.001 ETH".
- [x] Practice bots show as random addresses; show "Bot (Hard)".
- [x] Hide the Analysis tab when the server has no analyst.
- [x] The LMS discount checkbox's accessible name is "on".
- [x] "Create lobby" is disabled on Arbitrum with no reason given.
- [x] "Staked lobbies escrow a real testnet stake" also shows on mainnet.
- [x] "Switch to Base" on a dev burner bound to Arbitrum can only fail; hide it there.
- [ ] History is lost when the server restarts with the in-memory archive
      (match #0 vanished from "Your matches"); rebuild it from on-chain events.
- [ ] The avatar panel says "Wearing #1" but never shows the picture.
- [x] A defeated proposal says "quorum was not reached, or more voted
      against than for"; the page knows which one.
- [x] Proposal ids are shown in decimal (`#582156…`) while the CLI uses hex
      (`0x80b4…`).
- [x] Your own new lobby is not marked as yours until you stake into it.
- [ ] The page stays dark under a light system theme (fine if intended).
- [x] Dates follow the browser's locale inside an English page ("20 lis,
      01:01", "11 lis 2026"). Pick one language.
- [x] A wallet holding delegated votes is not told: P2 read "You vote with
      your own stake" with 549,999 votes, 300,000 of them P8's. The
      delegator's line shows the delegate as a full 42-character address.

### 5. Second review (12 Nov): ideas not covered above

Recommended first: the "what am I in" bar and the background alerts (A),
then toasts and the transaction tray (B). Together they cover most of the
state bugs (23, 24, 27, 28, 40, 41, 42) from the player's side.

**A. Keep the player oriented**

- [x] **A "what am I in" bar under the header**, built on load and on
      every reconnect: a running match ("Rejoin"), a queue place ("Queued
      0:42 · Leave"), a table waiting for your stake ("Stake 0.001 · 2:10
      left"), a stake in transit, a lobby you can get a refund from
      ("Cancel & refund"). Today each of these is lost or buried after a
      reload.
- [x] **Queue chip in the header on every screen**, practice included,
      that turns into "Table ready · Stake" when you are matched. Today the
      queue shows only in the Find a match panel.
- [x] **Alerts when the tab is in the background.** (Notifications and sound are opt-in: "Notify me" in the queue panel, "Sound cues" in the move panel.) Nothing tells a player
      who switched tabs: no title change, notification or sound
      (the client has none). Flash the title ("● Table ready"), offer
      browser notifications for "matched" and "match starting", and a soft
      sound when a round opens or 10 s are left.

**B. Feedback you can trust**

- [x] **Toast queue with kinds.** There is one toast slot
      (`ui/chrome.ts:15`): a new message replaces the last after 5 s, so
      "Matched…" can vanish under the next one. Stack them, colour success
      / error / info differently, keep the important ones (matched, not
      seated, refunded) until dismissed, and give the container
      `role="status"` so screen readers announce them.
- [x] **Transaction tray.** Each transaction as a row: waiting for the
      wallet → sent → confirmed or failed (with the decoded reason, bug 5),
      linked to Basescan or Arbiscan. A stake from Arbitrum shows "in
      transit · Across" until it is seated or credited back. This is the
      natural home for the bug 40 fix.
- [x] **Clickable transaction hashes.** "tx 0x34bc…8f8b" in history and
      results is plain text; link it to the chain's explorer.

**C. Lobby list**

- [x] **Hide what you cannot join.** Other players' matchmade tables (the
      disabled "Matchmade" rows) and lobbies past their window are noise;
      collapse them under "Other tables". Keep yours on top with "your
      table", "your lobby" and "refund ready" tags.
- [x] **Seats as dots.** (Dots, no countdown ring.) Show four or eight small seat dots (filled,
      empty, with a chain badge) and a countdown ring from chain time,
      instead of "0/4 seats · needs 4 more to start · closes in 23d 1h".
- [x] **Invite link for private lobbies.** A private lobby has no way to
      bring friends; there is no lobby URL (the page reads only `?player`
      and `?chain`). "Copy invite link" → `?lobby=0x…` opens the lobby with
      Stake ready.
- [x] **Stake range next to Create lobby** ("0.001 – 1 ETH", from the
      config's min and max stake), accepting "0,005" (bug 17).
- [x] **Say what the LMS discount buys.** "20000 LMS buys 1 ETH off a fee,
      up to half of each fee" → "Pay 0.5 LMS to save 0.000025 ETH on this
      join", shown on the join step.

**D. Match screen**

- [x] **You always at the bottom.** Seats are placed by index from the top
      (`arena/layout.ts:60`), so "YOU" sits at the top in one match and on
      the left in the next. Rotate the ring so your seat is always at the
      bottom, nearest the move buttons.
- [x] **A personal round recap.** One line under the timer after each
      round: "You took 25 from #3 · your guard reflected 34 to #1 · you
      are charged". Players read their own outcome first.
- [x] **Missed-round warning.** "You did not lock in: every strike on you
      hit" after a missed round, and a pulse on the timer at 10 s.
- [x] **Play again.** At the end of practice, "Play again" with the same
      bots and difficulty; at the end of a staked match, "Find another
      match" in the same tier. Today the only button is Back to lobby.
- [x] **List view for 8 seats on a phone** (Done instead by shrinking a crowded ring and dropping the seat captions; the target buttons stay as the list.) (bug 44): rows with HP bars and
      a Strike button each, instead of the ring.

**E. History and progress**

- [x] **Money on each history row** ("+0.00095 ETH", "−0.001 ETH") and a
      total for the week. Today rows show only place and rounds.
- [x] **Filters** (Staked / Practice) and a short stats line: matches,
      wins, average place, most-used move (the Reads data already exists).

**F. First visit**

- [ ] **Guest practice without a wallet** (bug 29; partly: logged out, "Start practice match" now connects first and the lobby list says why it is empty. A walletless guest needs the server to allow it), then a guided first
      round that points at Strike, Guard and Charge and the cooldowns.
- [x] **A "before you stake" step** the first time someone stakes: the 5%
      fee, the 60/25/15 split, the 1h challenge window and collecting,
      with "don't show again".
- [x] **Explain the jargon in place** with small "?" tips: sLMS, epoch,
      vesting, session key, one-click play, challenge window.

**G. Governance**

- [x] **Lifecycle stepper on each proposal**: Pending → Active → Succeeded
      → Queued → Executed, with the chain-time date under each step and
      the current one highlighted.
- [x] **Plain-language actions.** "Set the protocol fee to 0%" instead of
      the full `setParams({…})` struct; flag risky ones (zero guardian,
      unpause while not paused, duplicates; bug 38).

**H. Accessibility**

- [x] Announce round results and the last 10 s of the timer through an
      `aria-live` region (today only the loader and analysis have one).
- [x] Do not rely on colour alone for HP and "charged": add the number and
      an icon (HP numbers exist; check the charged state).

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

## Confirmed fixed from TODO_FIX.md

- A matched lobby shows up without Refresh.
- A clear "← Back to lobby" button at the end of a match.
- The result screen says what you won and when it can be collected.
- The Governance button comes back after a match.
- Vote buttons show on proposals, with voting dates and a countdown.
- On Arbitrum, Collect with an empty balance is disabled with a message.
- On Arbitrum, the staking panel says to switch to Base.
