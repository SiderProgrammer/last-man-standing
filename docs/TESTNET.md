# Hub and spoke on two testnets

How to run a cross-chain join between two public testnets: Base Sepolia as the
hub, Arbitrum Sepolia as a spoke, with Across carrying the stake. Everything
here has run locally with `npm run dev:fork` (mock SpokePools, a local
relayer), and the contracts have run against Across's real mainnet pools in
fork tests; this is the same flow against Across's testnet. It needs testnet
ETH on both chains. No Across configuration is needed: the router and the
receiver use the SpokePools Across already runs.

| | Hub | Spoke |
| --- | --- | --- |
| Chain | Base Sepolia, `84532` | Arbitrum Sepolia, `421614` |
| Across SpokePool and WETH | `contracts/config/across.json` | same |
| Fee API | `https://testnet.across.to/api` | |

Across documents its testnet as unreliable: fills take about a minute, and an
unfilled deposit is **not** refunded. Use small amounts. See
[ACROSS.md](ACROSS.md) for what was checked about Across, and what was not.

## Before you start

- A Safe on Base Sepolia, and a guardian address that is neither the Safe nor the
  deployer.
- A VRF v2.5 subscription at [vrf.chain.link](https://vrf.chain.link/), created
  while connected as the Safe, so the Safe is its admin, and funded with native
  ETH. On Base Sepolia's 30 gwei lane, keep at least 0.05 ETH in it.
- An RPC whose `eth_getLogs` accepts 10,000 blocks, which is the range the server
  scans. Alchemy's free tier allows 10 and is not enough for the server, though
  the deploy itself works on it.

## 1. Deploy the hub

```bash
cd contracts
DEPLOYER_PK=0x… SAFE=0x… GUARDIAN=0x… TEAM_BENEFICIARY=0x… \
VRF_SUBSCRIPTION_ID=… MATCHMAKER=0x… \
ATTESTOR=0x… ETHERSCAN_API_KEY=… \
forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
```

Use one `ATTESTOR`: the server submits a single signature, so a set that needs
more than one reverts every `settle` and `abortMatch` with `QuorumNotMet`.

Besides the escrow and governance, the script deploys the `BridgeJoinReceiver`
on Base Sepolia's SpokePool, owned by the timelock, and names it in the config.
`MATCHMAKER` is the address of the server's `MATCHMAKER_PK`: the only account
that can open the lobbies that earn play-mining. `--verify` verifies every
contract on the explorer.

The script writes `contracts/deployments/84532.json`: every address it created
(the receiver as `bridgeReceiver`) and the block to start scanning logs from.
Commit it. The server reads it for `CHAIN_ID=84532`, so its escrow, governor
and start blocks need no `.env` entries; an env variable still overrides one.

Then, connected as the Safe at [vrf.chain.link](https://vrf.chain.link/), add
`randomnessOracle` from that file to the subscription with **Add Consumer**.
Until it is added, the adapter's randomness requests are refused, so no staked
match can get its seed.

## 2. Deploy the spoke

```bash
DEPLOYER_PK=0x… SPOKE_OWNER=0x… \
HUB_CHAIN_ID=84532 HUB_RECEIVER=0x… \
ETHERSCAN_API_KEY=… \
forge script script/DeploySpoke.s.sol:DeploySpoke --rpc-url $ARBITRUM_SEPOLIA_RPC --broadcast --verify
```

`HUB_RECEIVER` is `bridgeReceiver` in the hub's registry; the hub's WETH and
this chain's SpokePool come from `config/across.json`. `SPOKE_OWNER` owns the
spoke's avatar collection and is required even with `AVATARS=false`. The script
deploys no timelock for it, so on testnet use a wallet or a Safe on that chain.
The `SpokeRouter` has no owner. This writes `contracts/deployments/421614.json`.

Nothing needs registering on the hub: the receiver takes a fill from any chain
Across serves.

## 3. Point the server and the client at both

The server needs four keys, each its own, and refuses to start if two are the
same: `ATTESTOR_PK` (the `ATTESTOR` address), `KEEPER_PK` and `SESSION_RELAYER_PK`
(gas money only), and `MATCHMAKER_PK` (the `MATCHMAKER` address). Then:

```bash
SPOKES='[{"chainId":421614,"router":"0x…"}]'
AVATAR_COLLECTIONS='[{"chainId":84532,"address":"0x…","rpcUrl":"…"},{"chainId":421614,"address":"0x…","rpcUrl":"…"}]'
```

Build the client with `VITE_ACROSS_API=https://testnet.across.to/api`, which
prices each join and is added to the page's Content-Security-Policy.

## 4. Try it

1. Open a lobby on the hub.
2. Switch the wallet to Arbitrum Sepolia. The chip reads
   "Staking from Arbitrum Sepolia → Base Sepolia hub".
3. **Stake from ARB**, then **Pay … + … fee**. The row reads *In transit…*.
4. Follow the deposit on Across's testnet explorer. When a relayer fills it,
   the client says the seat was taken and the lobby shows an ARB chip.
5. To see a refund, join a lobby that will fill before the deposit is filled;
   the client says why, and the stake is collectable on the hub.

6. To bring a balance back, stay on Arbitrum Sepolia: the Winnings panel offers
   **Collect to Arbitrum Sepolia**. The first click shows what arrives after
   Across's fee; the second signs the withdrawal, and the server submits it on
   Base Sepolia from `SESSION_RELAYER_PK`, which needs a little Base Sepolia ETH.
