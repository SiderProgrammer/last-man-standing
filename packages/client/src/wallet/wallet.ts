import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseSignature,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PlayRewards, StakingPosition } from '../ui/staking.js';
import type { ProposalLive } from '../ui/governance.js';
import type { ProposalAction, ProposalContext } from '../ui/proposalBuilder.js';
import {
  AUTH_PREFIX,
  ZERO_ADDRESS,
  ProposalState,
  claimableEpochRange,
  descriptionHash,
  rewardsDistributorAbi,
  gameEscrowAbi,
  lmsGovernorAbi,
  protocolConfigAbi,
  lmsTokenAbi,
  playerAvatarsAbi,
  stakedLmsAbi,
  sessionKeyDelegateAbi,
  v4QuoterAbi,
  zapJoinAbi,
  type ProposalStateValue,
  type ProtocolParams,
  type ProposalSummary,
  type VoteSupportValue,
  type ZapPathKey,
} from '@lms/protocol';

/**
 * `approve` with no return value.
 *
 * USDT and a handful of older tokens return nothing from `approve`, and a
 * simulation against the standard ABI then fails decoding a `bool` that was
 * never sent. Ignoring the return value is what `SafeERC20` does on-chain; a
 * token that actually refuses the approval still reverts.
 */
const approveAbi = parseAbi(['function approve(address spender, uint256 amount)']);

/** How long a staking permit signature stays valid, in seconds. */
const PERMIT_SECONDS = 10 * 60;

/**
 * What a session key is granted: logins, and nothing else.
 *
 * The hub is Ethereum L1. A call made through the key needs somebody else to
 * submit it, and on L1 that means the server paying L1 gas for every join and
 * mint. So players send their own transactions, and the key only signs the
 * login nonce, which the gateway checks through ERC-1271 with no transaction
 * at all. No call is allowed and no value may move: a leaked key can log in as
 * the player until it expires, and do nothing else.
 */
export const SESSION_GRANT = {
  spendCap: 0n,
  targets: [] as readonly Address[],
  selectors: [] as readonly Hex[],
} as const;

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/**
 * Thin wrapper over the injected wallet.
 *
 * Everything that moves value goes through here; the game server never holds a
 * key on the player's behalf and never sees one. The only signature the server
 * receives is over the login nonce, which proves address ownership and nothing
 * else — it cannot authorise a transfer.
 */
export class Wallet {
  private constructor(
    readonly address: Address,
    readonly chainId: number,
    /**
     * The injected path passes a bare address, which viem routes back to the
     * provider. The burner passes a local account, which signs in-process — the
     * distinction matters because a burner has no RPC to sign through.
     */
    private readonly account: Address | LocalAccount,
    private readonly wallet: WalletClient,
    private readonly rpc: PublicClient,
  ) {}

  static available(): boolean {
    return typeof window !== 'undefined' && Boolean(window.ethereum);
  }

  static async connect(): Promise<Wallet> {
    const provider = window.ethereum;
    if (!provider) throw new Error('No EIP-1193 wallet found. Install MetaMask or Rabby.');

    const transport = custom(provider);
    const wallet = createWalletClient({ transport });
    const rpc = createPublicClient({ transport });

    const [address] = await wallet.requestAddresses();
    if (!address) throw new Error('Wallet returned no accounts');
    const chainId = await rpc.getChainId();

    return new Wallet(address, chainId, address, wallet, rpc);
  }

  /**
   * Development-only burner, used when no extension is installed.
   *
   * The key comes from `VITE_DEV_KEY` and the caller only enables this in a dev
   * build, so it can never reach a production bundle. It exists because the
   * practice loop needs nothing but a login signature, and requiring a wallet
   * extension to click through the game locally is pure friction.
   */
  static async burner(privateKey: Hex, rpcUrl = 'http://127.0.0.1:8545'): Promise<Wallet> {
    const account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    const rpc = createPublicClient({ transport });

    // The chain id decides which avatar collection applies and which chain a
    // session key is stored against, so it has to be the node's real one.
    // Practice needs no node at all, though, so an unreachable RPC must not
    // hold up the login: ask once, briefly, and fall back to 0.
    let chainId = 0;
    try {
      chainId = await createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 1_500 }) }).getChainId();
    } catch {
      // No node: practice only.
    }

    return new Wallet(account.address, chainId, account, createWalletClient({ account, transport }), rpc);
  }

  /** Signs the server's login nonce. Plain personal_sign, no typed data needed. */
  signLogin(nonce: string): Promise<Hex> {
    return this.wallet.signMessage({
      account: this.account,
      message: `${AUTH_PREFIX}${nonce}`,
    });
  }

  /**
   * Each of these simulates before signing, so an on-chain revert (lobby full,
   * wrong stake, already seated) surfaces as a readable error instead of a
   * wallet prompt the player pays gas to watch fail.
   *
   * The `simulate -> write` shape repeats rather than being wrapped in a
   * helper: viem infers argument types from the literal `abi` and
   * `functionName` at each call site, and a wrapper erases that, trading four
   * compile-time-checked calls for four unchecked ones.
   */
  async createMatch(escrow: Address, stakeEth: string, seats: number): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'createMatch',
      args: [parseEther(stakeEth), seats],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  async join(escrow: Address, matchId: Hex, stakeWei: bigint): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'join',
      args: [matchId],
      value: stakeWei,
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * What `path` charges for exactly `stakeWei` of ETH, in the token's units.
   *
   * The quoter executes the swap and reverts with the result, so this is a
   * simulation rather than a read — and costs nothing and signs nothing.
   */
  async quoteZap(quoter: Address, path: readonly ZapPathKey[], stakeWei: bigint): Promise<bigint> {
    const { result } = await this.rpc.simulateContract({
      address: quoter,
      abi: v4QuoterAbi,
      functionName: 'quoteExactOutput',
      args: [{ exactCurrency: ZERO_ADDRESS, path: [...path], exactAmount: stakeWei }],
    });
    return result[0];
  }

  tokenBalance(token: Address): Promise<bigint> {
    return this.rpc.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.address],
    });
  }

  tokenAllowance(token: Address, spender: Address): Promise<bigint> {
    return this.rpc.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.address, spender],
    });
  }

  /**
   * Sets the allowance to exactly `amount`, and waits for it.
   *
   * USDT refuses to move an allowance from one non-zero value to another, and
   * every token join leaves the unused slippage allowance behind, so the second
   * USDT join would fail. When the direct approval does not simulate and an
   * allowance is outstanding, it is zeroed first — one extra prompt, only for
   * the tokens that need it.
   */
  async approveToken(token: Address, spender: Address, amount: bigint): Promise<void> {
    const approve = (value: bigint) =>
      this.rpc.simulateContract({
        account: this.address,
        address: token,
        abi: approveAbi,
        functionName: 'approve',
        args: [spender, value],
      });

    let simulation;
    try {
      simulation = await approve(amount);
    } catch (error) {
      if ((await this.tokenAllowance(token, spender)) === 0n) throw error;
      const reset = await approve(0n);
      await this.waitFor(await this.wallet.writeContract({ ...reset.request, chain: null }));
      simulation = await approve(amount);
    }
    await this.waitFor(await this.wallet.writeContract({ ...simulation.request, chain: null }));
  }

  /** Swaps the route's first token for the stake and takes the seat, in one transaction. */
  async joinWithToken(
    zap: Address,
    matchId: Hex,
    path: readonly ZapPathKey[],
    maxAmountIn: bigint,
    deadline: bigint,
  ): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: zap,
      abi: zapJoinAbi,
      functionName: 'joinWithToken',
      args: [matchId, [...path], maxAmountIn, deadline],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  async withdraw(escrow: Address): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'withdraw',
      args: [this.address],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /** History root the escrow stored when the match settled; zero before that. */
  async settledRoot(escrow: Address, matchId: Hex): Promise<Hex> {
    const info = await this.rpc.readContract({
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'getMatch',
      args: [matchId],
    });
    return info.historyRoot;
  }

  async withdrawableEth(escrow: Address): Promise<string> {
    const wei = await this.rpc.readContract({
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'withdrawable',
      args: [this.address],
    });
    return formatEther(wei);
  }

  /**
   * Mints the caller's avatar on the collection deployed to *this* chain.
   *
   * Nothing bridges: the collection the player mints from is the one the server
   * will read when they take a seat, which is the collection on the chain they
   * staked from.
   */
  async mintAvatar(collection: Address): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: collection,
      abi: playerAvatarsAbi,
      functionName: 'mint',
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /** Everything the avatar panel needs, in one round trip per field. */
  async avatarStatus(
    collection: Address,
  ): Promise<{ equipped: bigint; minted: boolean; totalMinted: bigint; maxSupply: bigint }> {
    const [equipped, minted, totalMinted, maxSupply] = await Promise.all([
      this.rpc.readContract({
        address: collection,
        abi: playerAvatarsAbi,
        functionName: 'equipped',
        args: [this.address],
      }),
      this.rpc.readContract({
        address: collection,
        abi: playerAvatarsAbi,
        functionName: 'hasMinted',
        args: [this.address],
      }),
      this.rpc.readContract({
        address: collection,
        abi: playerAvatarsAbi,
        functionName: 'totalMinted',
      }),
      this.rpc.readContract({
        address: collection,
        abi: playerAvatarsAbi,
        functionName: 'maxSupply',
      }),
    ]);
    return { equipped, minted, totalMinted, maxSupply };
  }

  /** Everything the staking panel shows, read in one round trip. */
  async stakingPosition(vault: Address): Promise<StakingPosition> {
    const lms = await this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'asset' });
    const [lmsBalance, shares, votes, delegate, earned, cooldown, [pendingAssets, unlockAt], block] = await Promise.all([
      this.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'balanceOf', args: [this.address] }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'balanceOf', args: [this.address] }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'getVotes', args: [this.address] }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'delegates', args: [this.address] }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'earned', args: [this.address] }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'cooldown' }),
      this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'unstakeOf', args: [this.address] }),
      this.rpc.getBlock(),
    ]);
    const value =
      shares === 0n
        ? 0n
        : await this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'convertToAssets', args: [shares] });
    return {
      lmsBalance,
      shares,
      value,
      votes,
      self: this.address,
      delegate,
      earned,
      cooldown: Number(cooldown),
      pending: { assets: pendingAssets, unlockAt: Number(unlockAt) },
      chainTime: Number(block.timestamp),
    };
  }

  /**
   * Stakes `amount` LMS in one transaction: an EIP-2612 signature grants the
   * vault its allowance, and `depositWithPermit` uses it straight away. The
   * signature is free, so a player sees one signing prompt and one
   * transaction instead of an approval and a deposit.
   */
  async stake(vault: Address, amount: bigint): Promise<Hex> {
    const lms = await this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'asset' });
    const [name, nonce] = await Promise.all([
      this.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'name' }),
      this.rpc.readContract({ address: lms, abi: lmsTokenAbi, functionName: 'nonces', args: [this.address] }),
    ]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_SECONDS);
    const signature = await this.wallet.signTypedData({
      account: this.account,
      domain: { name, version: '1', chainId: this.chainId, verifyingContract: lms },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: { owner: this.address, spender: vault, value: amount, nonce, deadline },
    });
    const { r, s, v, yParity } = parseSignature(signature);

    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: vault,
      abi: stakedLmsAbi,
      functionName: 'depositWithPermit',
      args: [amount, this.address, deadline, Number(v ?? BigInt(yParity + 27)), r, s],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * Hands this wallet's votes to `delegatee`, or takes them back with its own
   * address. The sLMS stays here and keeps earning; only the votes move.
   */
  async delegateVotes(vault: Address, delegatee: Address): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: vault,
      abi: stakedLmsAbi,
      functionName: 'delegate',
      args: [delegatee],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /** Burns `shares` now and starts the cooldown on what they are worth. */
  async requestUnstake(vault: Address, shares: bigint): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: vault,
      abi: stakedLmsAbi,
      functionName: 'requestUnstake',
      args: [shares],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /** Withdraws unstaked LMS once the cooldown has passed. */
  async claimUnstaked(vault: Address): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: vault,
      abi: stakedLmsAbi,
      functionName: 'claim',
      args: [this.address],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * Play-mining LMS this wallet can claim now, and the epochs it comes from.
   * One `eth_call` over every epoch that has ended: the distributor loops.
   */
  async playRewards(distributor: Address): Promise<PlayRewards> {
    const [firstEpoch, epochLength, programEpochs, block] = await Promise.all([
      this.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'firstEpoch' }),
      this.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'epochLength' }),
      this.rpc.readContract({ address: distributor, abi: rewardsDistributorAbi, functionName: 'PROGRAM_EPOCHS' }),
      this.rpc.getBlock(),
    ]);
    const range = claimableEpochRange(firstEpoch, epochLength, programEpochs, block.timestamp);
    if (!range) return { claimable: 0n, epochs: [] };
    const [claimable, epochs] = await this.rpc.readContract({
      address: distributor,
      abi: rewardsDistributorAbi,
      functionName: 'claimable',
      args: [this.address, range.from, range.to],
    });
    return { claimable, epochs: [...epochs] };
  }

  /** Claims play-mining rewards for `epochs`, paid to this wallet as sLMS. */
  async claimPlayRewards(distributor: Address, epochs: readonly bigint[]): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: distributor,
      abi: rewardsDistributorAbi,
      functionName: 'claim',
      args: [this.address, [...epochs]],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /** Pays the ETH this wallet has earned from fees to itself. */
  async claimRewards(vault: Address): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: vault,
      abi: stakedLmsAbi,
      functionName: 'claimRewards',
      args: [this.address],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * A proposal's state and this wallet's part in it.
   *
   * Voting power and quorum are fixed at the snapshot, which is the vote's
   * start. While that is still ahead the governor refuses to look it up, so a
   * pending proposal shows the wallet's power now, read from the vault.
   */
  async proposalLive(governor: Address, vault: Address, proposal: ProposalSummary): Promise<ProposalLive> {
    const id = BigInt(proposal.id);
    const [state, [against, forVotes, abstain], hasVoted, eta, block] = await Promise.all([
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'state', args: [id] }),
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalVotes', args: [id] }),
      this.rpc.readContract({
        address: governor,
        abi: lmsGovernorAbi,
        functionName: 'hasVoted',
        args: [id, this.address],
      }),
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalEta', args: [id] }),
      this.rpc.getBlock(),
    ]);
    const pending = state === ProposalState.Pending;
    const snapshot = BigInt(proposal.voteStart);
    const [power, quorum] = pending
      ? [
          await this.rpc.readContract({ address: vault, abi: stakedLmsAbi, functionName: 'getVotes', args: [this.address] }),
          null,
        ]
      : await Promise.all([
          this.rpc.readContract({
            address: governor,
            abi: lmsGovernorAbi,
            functionName: 'getVotes',
            args: [this.address, snapshot],
          }),
          this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'quorum', args: [snapshot] }),
        ]);
    return {
      state: state as ProposalStateValue,
      votes: { for: forVotes, against, abstain },
      quorum,
      power,
      hasVoted,
      eta: Number(eta),
      chainTime: Number(block.timestamp),
    };
  }

  /** Votes on a proposal, with a reason recorded on-chain when one is given. */
  async castVote(governor: Address, proposalId: string, support: VoteSupportValue, reason: string): Promise<Hex> {
    const id = BigInt(proposalId);
    if (reason.trim()) {
      const { request } = await this.rpc.simulateContract({
        account: this.address,
        address: governor,
        abi: lmsGovernorAbi,
        functionName: 'castVoteWithReason',
        args: [id, support, reason.trim()],
      });
      return this.wallet.writeContract({ ...request, chain: null });
    }
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'castVote',
      args: [id, support],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * Everything the proposal form needs: where each governed contract is, the
   * config's current parameters, and whether this wallet may propose at all.
   *
   * The governor checks the proposer's votes one second in the past, so that
   * is the number compared against the threshold here too.
   */
  async proposalContext(
    governor: Address,
    known: { vault: Address; feeRouter: Address | null; escrow: Address | null },
  ): Promise<{ context: ProposalContext; power: bigint; threshold: bigint }> {
    const [timelock, threshold, clock, config] = await Promise.all([
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'timelock' }),
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'proposalThreshold' }),
      this.rpc.readContract({ address: governor, abi: lmsGovernorAbi, functionName: 'clock' }),
      known.escrow
        ? this.rpc.readContract({ address: known.escrow, abi: protocolConfigAbi, functionName: 'config' })
        : Promise.resolve(null),
    ]);
    const [power, params] = await Promise.all([
      clock > 0
        ? this.rpc.readContract({
            address: governor,
            abi: lmsGovernorAbi,
            functionName: 'getVotes',
            args: [this.address, BigInt(clock - 1)],
          })
        : Promise.resolve(0n),
      config
        ? this.rpc.readContract({ address: config, abi: protocolConfigAbi, functionName: 'getParams' })
        : Promise.resolve(null),
    ]);
    return {
      context: { governor, timelock, config, params: params as ProtocolParams | null, ...known },
      power,
      threshold,
    };
  }

  /** Submits a proposal. Simulated first, so a missing threshold reads as the governor's own error. */
  async propose(governor: Address, actions: readonly ProposalAction[], description: string): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'propose',
      args: [
        actions.map((action) => action.target),
        actions.map((action) => action.value),
        actions.map((action) => action.calldata),
        description,
      ],
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * Queues a passed proposal in the timelock, or executes a queued one once
   * its delay is over. Both are open to anyone; the governor re-derives the
   * proposal from exactly these arguments, so they must match what was proposed.
   */
  async advanceProposal(governor: Address, proposal: ProposalSummary, step: 'queue' | 'execute'): Promise<Hex> {
    const args = [
      proposal.targets,
      proposal.values.map((value) => BigInt(value)),
      proposal.calldatas,
      descriptionHash(proposal.description),
    ] as const;
    if (step === 'queue') {
      const { request } = await this.rpc.simulateContract({
        account: this.address,
        address: governor,
        abi: lmsGovernorAbi,
        functionName: 'queue',
        args,
      });
      return this.wallet.writeContract({ ...request, chain: null });
    }
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: governor,
      abi: lmsGovernorAbi,
      functionName: 'execute',
      args,
    });
    return this.wallet.writeContract({ ...request, chain: null });
  }

  /**
   * Delegates this EOA under EIP-7702 and grants a login-only session key, in
   * one transaction.
   *
   * The authorization and the `grantSession` call travel together: the
   * transaction is addressed to the player's *own* address, which only has code
   * to call because the authorization in the same transaction put it there.
   * That is what makes this a one-time cost rather than a setup ritual.
   *
   * The key may call nothing and move nothing; see `SESSION_GRANT`.
   */
  async grantSession(delegate: Address, sessionKey: Address, validUntil: number): Promise<Hex> {
    const { spendCap, targets, selectors } = SESSION_GRANT;

    const authorization = await this.wallet.signAuthorization({
      account: this.account,
      contractAddress: delegate,
      // The account sends this very transaction, so by the time the
      // authorization is checked its nonce has already advanced by one.
      executor: 'self',
    });

    return this.wallet.sendTransaction({
      account: this.account,
      chain: null,
      to: this.address,
      authorizationList: [authorization],
      data: encodeFunctionData({
        abi: sessionKeyDelegateAbi,
        functionName: 'grantSession',
        args: [sessionKey, validUntil, spendCap, [...targets], [...selectors]],
      }),
    });
  }

  /** Ends a session on-chain, so a stolen key stops working immediately. */
  async revokeSession(sessionKey: Address): Promise<Hex> {
    return this.wallet.sendTransaction({
      account: this.account,
      chain: null,
      to: this.address,
      data: encodeFunctionData({
        abi: sessionKeyDelegateAbi,
        functionName: 'revokeSession',
        args: [sessionKey],
      }),
    });
  }

  waitFor(hash: Hex): Promise<unknown> {
    return this.rpc.waitForTransactionReceipt({ hash });
  }
}
