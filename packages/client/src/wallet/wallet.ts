import {
  BaseError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import type { ChainRecord } from '@lms/engine';
import { privateKeyToAccount } from 'viem/accounts';
import { DEV_RPC_URL } from '../csp.js';
import { WrongChainError, viemChain } from './chains.js';
import {
  AUTH_PREFIX,
  ZERO_ADDRESS,
  grantTypedData,
  isDelegatedTo,
  gameEscrowAbi,
  playerAvatarsAbi,
  sessionKeyDelegateAbi,
  spokeRouterAbi,
  type SessionGrant,
  type BridgeQuote,
} from '@lms/protocol';

/** How long an EIP-2612 permit signature stays valid, in seconds. */
export const PERMIT_SECONDS = 10 * 60;

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

/** Stops the last connected wallet hearing about chain switches. */
let watching: (() => void) | null = null;

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/** What `Wallet.spokeRoute` reads from a `SpokeRouter`. */
export interface SpokeRoute {
  weth: Address;
  hubWeth: Address;
  hubReceiver: Address;
  hubChainId: number;
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
  /**
   * The chain the escrow and everything around it live on, as the server's
   * `hello` names it. Every write goes there except a join from a spoke and
   * minting an avatar, which happen on the chain the wallet is on.
   */
  hubChainId = 0;

  private constructor(
    readonly address: Address,
    /** Where the wallet is now; an injected one reports every switch. */
    private current: number,
    /**
     * The injected path passes a bare address, which viem routes back to the
     * provider. The burner passes a local account, which signs in-process — the
     * distinction matters because a burner has no RPC to sign through.
     */
    readonly signer: Address | LocalAccount,
    /**
     * Signs and sends. Public, with `rpc`, `signer` and `onHub`, for the
     * wallet modules loaded with their screens (`staking.ts`,
     * `governance.ts`, `zap.ts`), which keep their contracts' ABIs out of the
     * main bundle; everything else goes through the methods here.
     */
    readonly client: WalletClient,
    /** Reads, through the wallet's own node. */
    readonly rpc: PublicClient,
  ) {}

  /** The chain the wallet is on. */
  get chainId(): number {
    return this.current;
  }

  static available(): boolean {
    return typeof window !== 'undefined' && Boolean(window.ethereum);
  }

  /**
   * Connects the injected wallet. `onChainChanged` hears every network switch,
   * made here or in the wallet itself, so what the page shows follows it.
   */
  static async connect(onChainChanged: (chainId: number) => void = () => {}): Promise<Wallet> {
    const provider = window.ethereum;
    if (!provider) throw new Error('No EIP-1193 wallet found. Install MetaMask or Rabby.');

    const transport = custom(provider);
    const wallet = createWalletClient({ transport });
    const rpc = createPublicClient({ transport });

    const [address] = await wallet.requestAddresses();
    if (!address) throw new Error('Wallet returned no accounts');
    const connected = new Wallet(address, await rpc.getChainId(), address, wallet, rpc);

    // One listener per provider: connecting again hands it to the new wallet.
    watching?.();
    const listener = (hex: string) => {
      connected.current = Number(hex);
      onChainChanged(connected.current);
    };
    provider.on?.('chainChanged', listener);
    watching = () => provider.removeListener?.('chainChanged', listener);
    return connected;
  }

  /**
   * Development-only burner, used when no extension is installed.
   *
   * The key comes from `VITE_DEV_KEY` and the caller only enables this in a dev
   * build, so it can never reach a production bundle. It exists because the
   * practice loop needs nothing but a login signature, and requiring a wallet
   * extension to click through the game locally is pure friction.
   */
  static burner(privateKey: Hex, rpcUrl?: string): Promise<Wallet> {
    return Wallet.fromAccount(privateKeyToAccount(privateKey), rpcUrl);
  }

  /**
   * A wallet that signs in-process, through a viem local account: the dev
   * burner, or an embedded wallet wrapped with viem's `toAccount`. Unlike an
   * injected wallet, it can sign an EIP-7702 authorization for our delegate,
   * which is what one-click play needs.
   */
  static async fromAccount(account: LocalAccount, rpcUrl = DEV_RPC_URL): Promise<Wallet> {
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

  /**
   * Signs a session grant: the one prompt that lets a browser-held key sign
   * logins and moves for this wallet until the grant expires.
   */
  signGrant(grant: SessionGrant): Promise<Hex> {
    return this.client.signTypedData({ account: this.signer, ...grantTypedData(grant) });
  }

  /** Signs the server's login nonce. Plain personal_sign, no typed data needed. */
  signLogin(nonce: string): Promise<Hex> {
    return this.client.signMessage({
      account: this.signer,
      message: `${AUTH_PREFIX}${nonce}`,
    });
  }

  /**
   * Puts the wallet on `chainId`, or throws `WrongChainError`.
   *
   * An injected wallet is asked to switch, and to add the chain first if it
   * has never seen it. A wallet that signs in-process is bound to its node,
   * so it can only be refused. Called before anything is simulated: against
   * the wrong chain a simulation fails with something like "no code at
   * address", which says nothing useful.
   */
  async ensureChain(chainId: number): Promise<void> {
    if (this.current === chainId) return;
    if (typeof this.signer !== 'string') {
      throw new WrongChainError(this.current, chainId, 'This wallet signs on one network only.');
    }
    const chain = viemChain(chainId);
    try {
      try {
        await this.client.switchChain({ id: chainId });
      } catch (error) {
        if (!unknownChain(error) || chain.rpcUrls.default.http.length === 0) throw error;
        await this.client.addChain({ chain });
        await this.client.switchChain({ id: chainId });
      }
    } catch {
      throw new WrongChainError(this.current, chainId);
    }
    this.current = await this.rpc.getChainId();
    if (this.current !== chainId) throw new WrongChainError(this.current, chainId);
  }

  /** `ensureChain` for the hub, returning the chain every hub write names. */
  async onHub(): Promise<Chain> {
    if (this.hubChainId === 0) throw new Error('Not connected to the game server yet.');
    await this.ensureChain(this.hubChainId);
    return viemChain(this.hubChainId);
  }

  /**
   * Each of these simulates before signing, so an on-chain revert (lobby full,
   * wrong stake, already seated) surfaces as a readable error instead of a
   * wallet prompt the player pays gas to watch fail.
   *
   * Each also names the chain it is for, so viem refuses to sign if the
   * wallet has been switched away from it since.
   *
   * The `simulate -> write` shape repeats rather than being wrapped in a
   * helper: viem infers argument types from the literal `abi` and
   * `functionName` at each call site, and a wrapper erases that, trading four
   * compile-time-checked calls for four unchecked ones.
   */
  async createMatch(escrow: Address, stakeEth: string, seats: number): Promise<Hex> {
    const chain = await this.onHub();
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'createMatch',
      args: [parseEther(stakeEth), seats],
    });
    return this.client.writeContract({ ...request, chain });
  }

  async join(escrow: Address, matchId: Hex, stakeWei: bigint): Promise<Hex> {
    const chain = await this.onHub();
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'join',
      args: [matchId],
      value: stakeWei,
    });
    return this.client.writeContract({ ...request, chain });
  }

  /**
   * What a join through `router` needs to know that the router itself holds:
   * the WETH Across moves on this chain, the hub's, and where on the hub the
   * fill is paid. Immutable, so a caller may keep the answer.
   */
  async spokeRoute(router: Address): Promise<SpokeRoute> {
    const read = <F extends 'weth' | 'hubWeth' | 'hubReceiver' | 'hubChainId'>(functionName: F) =>
      this.rpc.readContract({ address: router, abi: spokeRouterAbi, functionName });
    const [weth, hubWeth, hubReceiver, hubChainId] = await Promise.all([
      read('weth'),
      read('hubWeth'),
      read('hubReceiver'),
      read('hubChainId'),
    ]);
    return { weth, hubWeth, hubReceiver, hubChainId: Number(hubChainId) };
  }

  /** This chain's latest block time, which a quote with no fee API is stamped with. */
  async chainTime(): Promise<number> {
    return Number((await this.rpc.getBlock()).timestamp);
  }

  /**
   * Bridges `value` to the hub to take a seat in `matchId`, from the spoke the
   * wallet is on. `quote.outputAmount` is the stake; the rest of `value` is
   * Across's fee. The seat is taken on the hub once a relayer fills the
   * deposit, or the stake credited there if the seat is gone by then.
   */
  async joinFromSpoke(
    spokeChainId: number,
    router: Address,
    matchId: Hex,
    quote: BridgeQuote,
    value: bigint,
  ): Promise<Hex> {
    await this.ensureChain(spokeChainId);
    const chain = viemChain(spokeChainId);
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: router,
      abi: spokeRouterAbi,
      functionName: 'join',
      // Zero seats the caller, which the router allows only for an account
      // that is the same on the hub: an EOA, delegated or not.
      args: [matchId, ZERO_ADDRESS, quote],
      value,
    });
    return this.client.writeContract({ ...request, chain });
  }






  async withdraw(escrow: Address): Promise<Hex> {
    const chain = await this.onHub();
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'withdraw',
      args: [this.address],
    });
    return this.client.writeContract({ ...request, chain });
  }

  /** History root the escrow stored when the match settled; zero before that. */
  /**
   * What the escrow holds about a proposed match: everything a transcript is
   * checked against, read from the chain rather than from the server.
   */
  async matchRecord(escrow: Address, matchId: Hex): Promise<ChainRecord> {
    const at = { address: escrow, abi: gameEscrowAbi, args: [matchId] } as const;
    const [info, seats, terms] = await Promise.all([
      this.rpc.readContract({ ...at, functionName: 'getMatch' }),
      this.rpc.readContract({ ...at, functionName: 'getSeats' }),
      this.rpc.readContract({ ...at, functionName: 'getMatchTerms' }),
    ]);
    return {
      seed: info.seed,
      rulesHash: terms.rulesHash,
      seats,
      rounds: info.rounds,
      historyRoot: info.historyRoot,
      rankingHash: info.rankingHash,
      transcriptHash: info.transcriptHash,
    };
  }

  /**
   * Checks a wallet's signature over typed data through the chain, so a
   * grant from a contract wallet (ERC-1271) verifies too.
   */
  verifyTyped(args: TypedDataDefinition & { address: Address; signature: Hex }): Promise<boolean> {
    return this.rpc.verifyTypedData(args).catch(() => false);
  }

  /**
   * Calls off a lobby that can no longer start, or a match never settled in
   * time, and refunds every seat. Permissionless once `cancellableAt` passes;
   * the refund is credited, to withdraw like winnings.
   */
  async cancelMatch(escrow: Address, matchId: Hex): Promise<Hex> {
    const chain = await this.onHub();
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'cancelMatch',
      args: [matchId],
    });
    return this.client.writeContract({ ...request, chain });
  }

  /**
   * Disputes a proposed result: its payout waits 48 hours more while the
   * guardian looks at the evidence whose hash this records.
   */
  async dispute(escrow: Address, matchId: Hex, evidenceHash: Hex): Promise<Hex> {
    const chain = await this.onHub();
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: escrow,
      abi: gameEscrowAbi,
      functionName: 'dispute',
      args: [matchId, evidenceHash],
    });
    return this.client.writeContract({ ...request, chain });
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
    const chain = viemChain(this.current);
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: collection,
      abi: playerAvatarsAbi,
      functionName: 'mint',
    });
    return this.client.writeContract({ ...request, chain });
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














  /**
   * True when this wallet can sign an EIP-7702 authorization itself. Injected
   * wallets cannot be asked for one for a contract of our choosing, so they
   * keep the normal flow: every join is their own transaction.
   */
  get canDelegate(): boolean {
    return typeof this.signer !== 'string';
  }

  /**
   * Delegates this EOA to `delegate` under EIP-7702 and grants `sessionKey` a
   * capped session, in one transaction.
   *
   * The authorization and the `grantSession` call travel together: the
   * transaction is addressed to the player's *own* address, which only has code
   * to call because the authorization in the same transaction put it there.
   * From then on the key may join lobbies and collect winnings for this
   * account, within the caps, and the server pays the gas.
   */
  async enableOneClick(
    delegate: Address,
    sessionKey: Address,
    validUntil: number,
    caps: { valueCap: bigint; spendCap: bigint },
  ): Promise<Hex> {
    const chain = await this.onHub();
    const authorization = await this.client.signAuthorization({
      account: this.signer,
      contractAddress: delegate,
      // The account sends this very transaction, so by the time the
      // authorization is checked its nonce has already advanced by one.
      executor: 'self',
    });

    return this.client.sendTransaction({
      account: this.signer,
      chain,
      to: this.address,
      authorizationList: [authorization],
      data: encodeFunctionData({
        abi: sessionKeyDelegateAbi,
        functionName: 'grantSession',
        args: [sessionKey, validUntil, caps.valueCap, caps.spendCap],
      }),
    });
  }

  /**
   * Whether `sessionKey` may act for this account through `delegate` now, and
   * the nonce its next call must carry. Off when the account is delegated
   * elsewhere, or not at all.
   */
  async oneClickStatus(
    delegate: Address,
    sessionKey: Address,
  ): Promise<{ active: boolean; validUntil: number; spent: bigint; spendCap: bigint; nonce: bigint }> {
    const off = { active: false, validUntil: 0, spent: 0n, spendCap: 0n, nonce: 0n };
    if (!isDelegatedTo(await this.rpc.getCode({ address: this.address }), delegate)) return off;
    const at = { address: this.address, abi: sessionKeyDelegateAbi } as const;
    const [[validUntil, , spendCap, spent], nonce, block] = await Promise.all([
      this.rpc.readContract({ ...at, functionName: 'sessions', args: [sessionKey] }),
      this.rpc.readContract({ ...at, functionName: 'sessionNonce' }),
      this.rpc.getBlock(),
    ]);
    return { active: validUntil > Number(block.timestamp), validUntil, spent, spendCap, nonce };
  }

  /** Ends a session on-chain, so a stolen key stops working immediately. */
  async revokeSession(sessionKey: Address): Promise<Hex> {
    const chain = await this.onHub();
    return this.client.sendTransaction({
      account: this.signer,
      chain,
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

/** True when a wallet refused to switch because it does not know the chain (EIP-3326's 4902). */
function unknownChain(error: unknown): boolean {
  const is4902 = (cause: unknown) => (cause as { code?: unknown } | null)?.code === 4902;
  return is4902(error) || (error instanceof BaseError && error.walk(is4902) !== null);
}
