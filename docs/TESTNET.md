# Hub and spoke on two testnets

How to run a cross-chain join between two public testnets: Sepolia as the hub,
Base Sepolia as a spoke. Everything here has run locally with `npm run dev:fork`
(mock endpoints, a local relayer); this is the same flow against real
LayerZero. It needs testnet ETH on both chains and a little LayerZero
configuration that cannot be done from this repository.

| | Hub | Spoke |
| --- | --- | --- |
| Chain | Sepolia, `11155111` | Base Sepolia, `84532` |
| LayerZero endpoint id | `40161` | `40245` |
| LayerZero `EndpointV2` | from LayerZero's deployed-contracts list | same |

Check the endpoint address for each chain in LayerZero's documentation rather
than copying one from here.

## 1. Deploy the hub

```bash
cd contracts
DEPLOYER_PK=0x… SAFE=0x… GUARDIAN=0x… TEAM_BENEFICIARY=0x… \
ORACLE=0x… \
LZ_ENDPOINT=0x… \
ATTESTORS=0x…,0x…,0x… ETHERSCAN_API_KEY=… \
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC --broadcast --verify
```

`ORACLE` is a `ChainlinkVrfAdapter` you deployed with the hub timelock as its
owner; register the escrow with `setConsumer` once it exists. `LZ_ENDPOINT`
makes the script deploy the hub `LayerZeroMessenger`, point it at the escrow,
make the timelock its endpoint delegate and hand it to the timelock with the
config. `--verify` verifies every contract on the explorer.

The script writes `contracts/deployments/11155111.json`: every address it
created and the block to start scanning logs from. Commit it. The server
reads it for `CHAIN_ID=11155111`, so its escrow, messenger, governor and
start blocks need no `.env` entries; an env variable still overrides one.

## 2. Deploy the spoke

```bash
DEPLOYER_PK=0x… SAFE=0x… SPOKE_OWNER=0x… \
HUB_CHAIN_ID=11155111 HUB_EID=40161 \
HUB_ESCROW=0x… HUB_MESSENGER=0x… \
LZ_ENDPOINT=0x… ETHERSCAN_API_KEY=… \
forge script script/DeploySpoke.s.sol:DeploySpoke --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify
```

`HUB_ESCROW` and `HUB_MESSENGER` are `escrow` and `messenger` in the hub's
registry. This one writes `contracts/deployments/84532.json`.

`SPOKE_OWNER` is the spoke's own timelock. The script wires the spoke side —
the messenger's app is the `SpokeEscrow`, its peer is the hub messenger — and
proposes `SPOKE_OWNER` as owner of both. It prints the two hub-side calls for
step 4. Then have `SPOKE_OWNER` call `acceptOwnership()` on the messenger and
the escrow.

## 3. Configure LayerZero on both messengers

Each messenger's delegate — the hub timelock, the spoke owner — sets its send
and receive libraries and its DVNs on the endpoint, with LayerZero's own
tooling. Without verifiers configured for the pathway, a message is sent and
paid for but never verified, and nothing on-chain can recover it. Do this
before step 5, in both directions.

While you are there, read the executor's `nativeCap` for Base Sepolia → Sepolia.
A lobby whose stake is above it cannot be joined from the spoke: `quoteJoin`
reverts with `Executor_NativeAmountExceedsCap`, which the client explains, and
nothing is sent.

## 4. Register the spoke on the hub

The hub's config and messenger belong to its timelock, so this is a proposal.
In the client's governance screen, **New proposal → Add a spoke chain**, with
chain id `84532`, endpoint id `40245`, and the `SpokeEscrow` and
`LayerZeroMessenger` from step 2. It adds both calls:

```
ProtocolConfig.setRemoteChain(84532, hubMessenger, spokeEscrow)
Hub messenger.setPeer(84532, 40245, spokeMessenger)
```

Vote, queue, wait out the timelock delay, execute.

A join sent before this executes is not lost. Until `setPeer`, the hub
messenger refuses to open the path, so LayerZero holds the message as verified
but not deliverable, and delivers it once the path opens. If `setPeer` lands
before `setRemoteChain`, the delivery parks in the hub messenger and the server
retries it once the config trusts the route.

## 5. Point the server at both

```bash
SPOKES='[{"chainId":84532,"escrow":"0x…"}]'
AVATAR_COLLECTIONS='[{"chainId":11155111,"address":"0x…","rpcUrl":"…"},{"chainId":84532,"address":"0x…","rpcUrl":"…"}]'
```

With `KEEPER_PK` set, the server also retries parked deliveries and pushes
payouts to players who have no gas on the hub.

## 6. Try it

1. Open a lobby on the hub.
2. Switch the wallet to Base Sepolia. The chip reads
   "Staking from Base Sepolia → Sepolia hub".
3. **Stake from BASE**, then **Pay … + … fee**. The row reads *In transit…*.
4. Follow the message on LayerZero Scan. When it lands, the client says the
   seat was taken and the lobby shows a BASE chip.
5. To see a refund, join a lobby that will fill before your message lands;
   the client says why, and the stake is collectable on the hub.
