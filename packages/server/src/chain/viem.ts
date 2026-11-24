import { createPublicClient, http, type Chain, type HttpTransport, type PublicClient } from 'viem';

/**
 * viem client construction for a chain known only by id and RPC URL.
 *
 * The server talks to whatever chain it is pointed at, so it cannot import a
 * chain definition from `viem/chains` — the hub may be an Anvil fork or a
 * testnet that viem has never heard of. It describes the chain from config
 * instead. This file is the one place that describes it.
 *
 * The description is deliberately minimal: viem needs an id for EIP-155
 * signing and an RPC URL to reach, and everything else here is filler it never
 * reads on these paths.
 */
export function rpcChain(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

/**
 * The one transport the server reaches an RPC through. A provider's API key is
 * part of its URL, and viem puts the URL in its errors, which are logged and,
 * for a request that fails, sent to the player who made it. So what this
 * transport throws names the RPC's host and nothing else of its URL.
 */
export function rpcTransport(rpcUrl: string): HttpTransport {
  const inner = http(rpcUrl);
  const redact = rpcUrlRedactor(rpcUrl);
  return (options) => {
    const transport = inner(options);
    const request = async (...args: Parameters<typeof transport.request>): Promise<unknown> => {
      try {
        return await transport.request(...args);
      } catch (error) {
        redactError(error, redact);
        throw error;
      }
    };
    return { ...transport, request: request as typeof transport.request };
  };
}

/** A key is at least this long; a shorter part of a URL is a word such as `rpc`. */
const KEY_LENGTH = 16;

/**
 * Replaces `rpcUrl` in a text with its origin, in each form viem and `fetch`
 * write it, and any long part of it that appears alone.
 */
function rpcUrlRedactor(rpcUrl: string): (text: string) => string {
  const url = URL.canParse(rpcUrl) ? new URL(rpcUrl) : null;
  if (!url) return (text) => text.replaceAll(rpcUrl, '[RPC URL]');
  const { origin, href } = url;
  const keys = [...url.pathname.split('/'), ...url.searchParams.values(), url.username, url.password].filter(
    (part) => part.length >= KEY_LENGTH,
  );
  // viem drops the credentials from some of the URLs it prints.
  url.username = '';
  url.password = '';
  const forms = [rpcUrl, href, url.href].filter((form) => form !== origin && form !== `${origin}/`);
  const secrets = [...new Set([...forms, ...keys])].sort((a, b) => b.length - a.length);
  return (text) =>
    secrets.reduce((out, secret) => out.replaceAll(secret, forms.includes(secret) ? `${origin}/[hidden]` : '[hidden]'), text);
}

/** Applies `redact` to every text an error and its causes hold: printing one prints its fields too. */
function redactError(error: unknown, redact: (text: string) => string, seen = new Set<unknown>()): void {
  if (!(error instanceof Error) || seen.has(error)) return;
  seen.add(error);
  const fields = error as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(error)) {
    const value = fields[name];
    if (typeof value === 'string') {
      const redacted = redact(value);
      if (redacted !== value) fields[name] = redacted;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      fields[name] = value.map(redact);
    } else {
      redactError(value, redact, seen);
    }
  }
}

/** Read-only client for a chain described by id and RPC URL. */
export function readClient(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({ chain: rpcChain(chainId, rpcUrl), transport: rpcTransport(rpcUrl) });
}
