/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket endpoint of the game server. Defaults to the current host on `DEFAULT_SERVER_PORT`. */
  readonly VITE_WS_URL?: string;
  /** RPC used by the development burner wallet. */
  readonly VITE_RPC_URL?: string;
  /** The spoke `npm run dev:fork` runs, which the burner uses on `?chain=spoke`. */
  readonly VITE_SPOKE_RPC_URL?: string;
  /** Development-only burner key, ignored in production builds. */
  readonly VITE_DEV_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
