import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AUTH_PREFIX,
  ZERO_ADDRESS,
  gameEscrowAbi,
  playerAvatarsAbi,
  sessionKeyDelegateAbi,
  v4QuoterAbi,
  zapJoinAbi,
  type ZapPathKey,
} from '@lms/protocol';

/**
 * Selector of a named function, taken from the ABI the rest of the file uses.
 *
 * The session scope used to hand-write the signatures a third time, next to
 * the ABIs that already describe them, which is one more place for them to
 * drift. `session-scope.test.ts` pins the resulting bytes4 values.
 */
function selectorOf(abi: Abi, name: string): Hex {
  const item = abi.find(
    (entry): entry is AbiFunction => entry.type === 'function' && entry.name === name,
  );
  if (!item) throw new Error(`no function ${name} in ABI`);
  return toFunctionSelector(item);
}

/**
 * What a session key may call, and nothing else.
 *
 * Deliberately narrow: join and withdraw on the escrow, mint and equip on the
 * avatar collection. It cannot create lobbies and it cannot transfer the
 * player's avatar away.
 */
export const SESSION_SCOPE = {
  escrow: [selectorOf(gameEscrowAbi as Abi, 'join'), selectorOf(gameEscrowAbi as Abi, 'withdraw')],
  avatars: [
    selectorOf(playerAvatarsAbi as Abi, 'mint'),
    selectorOf(playerAvatarsAbi as Abi, 'equip'),
  ],
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
  static burner(privateKey: Hex, rpcUrl = 'http://127.0.0.1:8545'): Wallet {
    const account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl);
    return new Wallet(
      account.address,
      0,
      account,
      createWalletClient({ account, transport }),
      createPublicClient({ transport }),
    );
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

  async approveToken(token: Address, spender: Address, amount: bigint): Promise<Hex> {
    const { request } = await this.rpc.simulateContract({
      account: this.address,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    });
    return this.wallet.writeContract({ ...request, chain: null });
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

  /**
   * Delegates this EOA under EIP-7702 and grants a scoped session key, in one
   * transaction.
   *
   * The authorization and the `grantSession` call travel together: the
   * transaction is addressed to the player's *own* address, which only has code
   * to call because the authorization in the same transaction put it there.
   * That is what makes this a one-time cost rather than a setup ritual.
   *
   * The scope is deliberately narrow. The key may join and withdraw from the
   * escrow and mint or equip an avatar — nothing else — and it may move at most
   * `spendCapWei` in total. It cannot create lobbies, and it cannot transfer
   * the player's avatar away.
   */
  async grantSession(
    delegate: Address,
    sessionKey: Address,
    validUntil: number,
    spendCapWei: bigint,
    contracts: { escrow: Address | null; avatars: Address | null },
  ): Promise<Hex> {
    const targets: Address[] = [];
    const selectors: Hex[] = [];

    if (contracts.escrow) {
      for (const selector of SESSION_SCOPE.escrow) {
        targets.push(contracts.escrow);
        selectors.push(selector);
      }
    }
    if (contracts.avatars) {
      for (const selector of SESSION_SCOPE.avatars) {
        targets.push(contracts.avatars);
        selectors.push(selector);
      }
    }

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
        args: [sessionKey, validUntil, spendCapWei, targets, selectors],
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

  /** Next session-call nonce for this account, for signing a relayed call. */
  async sessionNonce(): Promise<bigint> {
    return this.rpc.readContract({
      address: this.address,
      abi: sessionKeyDelegateAbi,
      functionName: 'sessionNonce',
    });
  }

  waitFor(hash: Hex): Promise<unknown> {
    return this.rpc.waitForTransactionReceipt({ hash });
  }
}
