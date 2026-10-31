/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * WebSocket endpoint of the game server. Defaults to the current host on
   * `DEFAULT_SERVER_PORT`, which the build's Content-Security-Policy allows
   * only on localhost: a deployed build must set it.
   */
  readonly VITE_WS_URL?: string;
  /** Space-separated origins avatar images load from, for the CSP. Defaults to `https://ipfs.io`. */
  readonly VITE_CSP_MEDIA?: string;
  /** RPC used by the development burner wallet. */
  readonly VITE_RPC_URL?: string;
  /** The spoke `npm run dev:fork` runs, which the burner uses on `?chain=spoke`. */
  readonly VITE_SPOKE_RPC_URL?: string;
  /**
   * Across's fee API, which prices joins from a spoke: `https://app.across.to/api`,
   * or `https://testnet.across.to/api` on testnet. Unset, a spoke join is
   * quoted with no fee, which only a local stack with mock SpokePools fills.
   */
  readonly VITE_ACROSS_API?: string;
  /** Development-only burner key, ignored in production builds. */
  readonly VITE_DEV_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
