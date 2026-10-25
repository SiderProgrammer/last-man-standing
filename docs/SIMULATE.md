# Simulating every feature

Three layers, from cheapest to most real. Every recipe below was run against a
fresh `npm run dev:fork`.

| Layer | What it shows | Command |
| --- | --- | --- |
| Foundry suites | Every contract path, including failures, with full call traces | `forge test --root contracts --match-contract <Suite> -vvvv` |
| The browser on a fork | What a player sees, against real contracts and real Uniswap pools | `npm run dev:fork`, then http://localhost:5174 |
| `cast` on the same fork | Everything with no UI yet: cancellation, governance, cross-chain, withdraw | the recipes below |

## 1. Foundry: one suite per feature

| Feature | Suite |
| --- | --- |
| Escrow lifecycle, pause, cancellation, cross-chain joins, `joinFor` | `GameEscrowTest` |
| Solvency under random call sequences, through settlement | `EscrowInvariantTest` |
| Attestor quorum and signature ordering | `SignatureLibTest`, `SignatureLibFuzzTest` |
| Payout maths, Yul against the reference | `SettlementLibTest`, `SettlementLibFuzzTest` |
| Spoke-chain gate | `SpokeEscrowTest` |
| LayerZero and Chainlink VRF adapters | `AdapterTest` |
| Governance parameters, guardian | `ProtocolConfigTest` |
| The real deploy: Safe → timelock → config, guardian | `DeployTest` |
| EIP-7702 session keys | `SessionKeyDelegateTest` |
| Avatars | `PlayerAvatarsTest` |
| Join with any token (mock pool / real mainnet pool) | `ZapJoinTest` / `ZapJoinForkTest` (needs `MAINNET_RPC_URL`) |

The off-chain side — commit–reveal, the round kernel, replays,
the gateway — is `npm test`.

## 2. In the browser (`npm run dev:fork`)

Covered by the UI: practice matches, staking in ETH, paying in USDC / USDT /
DAI through Uniswap v4, prompt-free logins (EIP-7702 session keys), avatar
minting, the staking panel's ETH and play-mining claims, and a staked match once
its lobby fills.

A staked lobby needs 4 wallets and has no bots, so fill the other seats from the
command line (§3.2). Once it is full the server locks it, the fork's oracle
loop seeds it a block later, and the lobby row turns into **Enter**.

## 3. `cast` recipes

### 3.1 Setup

Run in a second terminal while `dev:fork` is up. It reads the deployed
addresses from the fork's broadcast file and names anvil's dev accounts, which
anvil signs for itself (`--unlocked`), so no key is ever typed.

```bash
R=http://127.0.0.1:8545
eval "$(node -e "const d=require('./contracts/broadcast/Deploy.s.sol/31337/run-latest.json');const n={GameEscrow:'ESCROW',MockRandomnessOracle:'ORACLE',MockMessenger:'MESSENGER',ProtocolConfig:'CONFIG',TimelockController:'TIMELOCK'};for(const t of d.transactions)if(t.transactionType==='CREATE'&&n[t.contractName])console.log(n[t.contractName]+'='+t.contractAddress)")"
OP=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   # deployer: attestor, and on 31337 also the Safe and guardian
P1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8   # the browser's burner
P2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; P3=0x90F79bf6EB2c4f870365E785982E1f101E93b906; P4=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
FAN=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc  # an unrelated third party
next_match() { cast keccak $(cast abi-encode "f(uint256,address,uint256)" 31337 $ESCROW $(cast call $ESCROW 'matchNonce()(uint256)' --rpc-url $R)); }
status() { cast call $ESCROW 'getMatch(bytes32)((uint128,uint16,uint16,uint16,uint16,uint8,uint64,uint64,uint64,address,bytes32,bytes32,bytes32))' $1 --rpc-url $R | tr -d '()' | cut -d, -f6; }
warp() { cast rpc evm_increaseTime $1 --rpc-url $R; cast rpc evm_mine --rpc-url $R; }
```

Status codes: 1 Open · 2 Pending · 3 Live · 4 Settled · 5 Cancelled.

### 3.2 Fill a lobby for a browser match

The lobbies `dev:fork` opened are match nonces 0 and 1. Join from the browser
first, then seat the rest:

```bash
M=$(cast keccak $(cast abi-encode "f(uint256,address,uint256)" 31337 $ESCROW 0)); for P in $P2 $P3 $P4; do cast send --unlocked --from $P $ESCROW 'join(bytes32)' $M --value 0.01ether --rpc-url $R; done
```

Within 15 minutes of starting: that is the join window.

### 3.3 The whole lifecycle by hand

Lobby, four stakes, lock, seed, a quorum-signed result, withdrawal. Under `dev:fork` two steps happen on their own: the server's keeper
locks the lobby the moment it is full (so a manual `lockMatch` may revert with
`WrongStatus` — that is fine), and the oracle loop seeds it a block later. The
server then opens a room for it too; its own settlement will simply lose the
race to yours.

```bash
M=$(next_match); cast send --unlocked --from $OP $ESCROW 'createMatch(uint128,uint16)' 10000000000000000 4 --rpc-url $R
for P in $P1 $P2 $P3 $P4; do cast send --unlocked --from $P $ESCROW 'join(bytes32)' $M --value 0.01ether --rpc-url $R; done
cast send --unlocked --from $OP $ESCROW 'lockMatch(bytes32)' $M --rpc-url $R; sleep 3; status $M   # 3 = Live once seeded
```

Settlement is a result signed by the attestor quorum (1 of 1 on the fork).
Anvil signs the EIP-712 `MatchResult` for its own dev account, and anyone may
submit it:

```bash
ROOT=0x$(printf '11%.0s' {1..32}); RANKING="[$P1,$P3,$P2,$P4]"
JSON='{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"MatchResult":[{"name":"matchId","type":"bytes32"},{"name":"rounds","type":"uint32"},{"name":"historyRoot","type":"bytes32"},{"name":"ranking","type":"address[]"}]},"primaryType":"MatchResult","domain":{"name":"LastManStanding","version":"1","chainId":31337,"verifyingContract":"'$ESCROW'"},"message":{"matchId":"'$M'","rounds":7,"historyRoot":"'$ROOT'","ranking":["'$P1'","'$P3'","'$P2'","'$P4'"]}}'
SIG=$(cast rpc eth_signTypedData_v4 $OP "$JSON" --rpc-url $R | tr -d '"')
cast send --unlocked --from $FAN $ESCROW 'settle(bytes32,uint32,bytes32,address[],bytes)' $M 7 $ROOT "$RANKING" $SIG --rpc-url $R
for P in $P1 $P3 $P2 $P4; do cast call $ESCROW 'withdrawable(address)(uint256)' $P --rpc-url $R; done
```

Expected: a 0.04 ETH pool, 5 % to the treasury, the rest 60 / 25 / 15 —
`0.0228`, `0.0095`, `0.0057`, `0`. Then the withdrawal:

```bash
cast send --unlocked --from $P1 $ESCROW 'withdraw(address)' $P1 --rpc-url $R
```

### 3.4 Cancellation: every way a match can fail

```bash
M=$(next_match); cast send --unlocked --from $OP $ESCROW 'createMatch(uint128,uint16)' 10000000000000000 4 --rpc-url $R; cast send --unlocked --from $P1 $ESCROW 'join(bytes32)' $M --value 0.01ether --rpc-url $R
warp 901; cast send --unlocked --from $FAN $ESCROW 'cancelMatch(bytes32)' $M --rpc-url $R; status $M   # 5: under-filled lobby expired
cast call $ESCROW 'withdrawable(address)(uint256)' $P1 --rpc-url $R                                     # the stake, refundable
```

"Oracle never answered" is the same with four joins and a `lockMatch`, then
`warp 9000` before `cancelMatch` — but stop `dev:fork` first, since its oracle
loop answers within a second. A live match past its settlement deadline is the
third path (`GameEscrowTest.test_cancel_liveMatchAfterDeadline`).

### 3.5 Governance: Safe → timelock → config, and the guardian

On chain 31337 the deployer stands in for the Safe.

```bash
cast send --unlocked --from $OP $ESCROW 'pause()' --rpc-url $R; cast call $ESCROW 'paused()(bool)' --rpc-url $R   # guardian: immediate
cast send --unlocked --from $OP $ESCROW 'unpause()' --rpc-url $R                                                   # reverts NotGovernance
SALT=0x$(printf '00%.0s' {1..32}); CALL=$(cast calldata 'unpause()')
cast send --unlocked --from $OP $TIMELOCK 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' $ESCROW 0 $CALL $SALT $SALT 86400 --rpc-url $R
cast send --unlocked --from $FAN $TIMELOCK 'execute(address,uint256,bytes,bytes32,bytes32)' $ESCROW 0 $CALL $SALT $SALT --rpc-url $R   # reverts: too early
warp 86401; cast send --unlocked --from $FAN $TIMELOCK 'execute(address,uint256,bytes,bytes32,bytes32)' $ESCROW 0 $CALL $SALT $SALT --rpc-url $R   # anyone, once due
```

Warping a day expires every open lobby; restart `dev:fork` afterwards.

### 3.6 Cross-chain: a join from a spoke, and a payout back

The fork deploys a `MockMessenger` but registers no remote chain, so register
one through governance first, then play the transport:

```bash
PEER=0x000000000000000000000000000000000000000000000000000000000000beef; SALT2=0x$(printf '01%.0s' {1..32})
REG=$(cast calldata 'setRemoteChain(uint32,address,bytes32)' 421614 $MESSENGER $PEER)
cast send --unlocked --from $OP $TIMELOCK 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' $CONFIG 0 $REG $SALT $SALT2 86400 --rpc-url $R; warp 86401
cast send --unlocked --from $FAN $TIMELOCK 'execute(address,uint256,bytes,bytes32,bytes32)' $CONFIG 0 $REG $SALT $SALT2 --rpc-url $R
M=$(next_match); cast send --unlocked --from $OP $ESCROW 'createMatch(uint128,uint16)' 10000000000000000 4 --rpc-url $R
SPOKE_PLAYER=0x00000000000000000000000000000000000000a5
cast send --unlocked --from $FAN $MESSENGER 'deliver(address,uint32,bytes32,bytes,uint256)' $ESCROW 421614 $PEER $(cast abi-encode 'f(bytes32,address)' $M $SPOKE_PLAYER) 10000000000000000 --value 0.01ether --rpc-url $R
cast call $ESCROW 'seatOrigin(bytes32,address)(uint32)' $M $SPOKE_PLAYER --rpc-url $R   # 421614
```

A different `PEER` reverts with `UntrustedPeer`. Delivering the same join again
is refunded rather than reverted: `withdrawable(SPOKE_PLAYER)` shows the stake
credited back on the hub, and `withdrawFor(SPOKE_PLAYER)` pays it out.
