import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../src/csp.js';

const CLIENT = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

/** The directive's sources, or null when the policy has no such directive. */
function directive(policy: string, name: string): string[] | null {
  const found = policy.split('; ').find((entry) => entry.startsWith(`${name} `));
  return found ? found.split(' ').slice(1) : null;
}

describe('no markup from data', () => {
  /**
   * The page holds a key that signs moves and stakes. Markup built from a
   * string is how data becomes script, so the client builds every node with
   * `textContent` instead, and this keeps it that way.
   */
  it('never parses a string as HTML', () => {
    const offenders = sources(join(CLIENT, 'src')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
        .filter(({ line }) => /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write\(|createContextualFragment\(/.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });

  /** The policy refuses inline script and style, so the page must not need them. */
  it('ships a page with no inline script, style or handler', () => {
    const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });
});

describe('content security policy', () => {
  const policy = contentSecurityPolicy({
    VITE_WS_URL: 'wss://play.example.com:8443/socket',
    VITE_CSP_MEDIA: 'https://gateway.example',
  });

  it('allows no inline script and no eval', () => {
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(directive(policy, 'script-src')).toEqual(["'self'"]);
    expect(directive(policy, 'default-src')).toEqual(["'none'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'none'"]);
  });

  /** An injected script that did run still could not send a key anywhere unnamed. */
  it('names every origin the page talks to, and no wildcard', () => {
    expect(directive(policy, 'connect-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'wss://play.example.com:8443',
      'https://play.example.com:8443',
      'https://gateway.example',
    ]);
    expect(policy).not.toMatch(/(^|\s)(\*|https:|wss:|http:|ws:)(\s|;|$)/);
  });

  it('names the dev RPCs only in a dev build, and the local server by default', () => {
    const env = { VITE_RPC_URL: 'http://127.0.0.1:9545', VITE_SPOKE_RPC_URL: 'http://127.0.0.1:9546/' };
    const dev = directive(contentSecurityPolicy(env, { dev: true }), 'connect-src') ?? [];
    expect(dev).toEqual(expect.arrayContaining(['http://127.0.0.1:9545', 'http://127.0.0.1:9546', 'ws://localhost:8787']));
    expect(directive(contentSecurityPolicy({}, { dev: true }), 'connect-src')).toContain('http://127.0.0.1:8545');

    const production = directive(contentSecurityPolicy(env), 'connect-src') ?? [];
    expect(production.some((source) => source.includes(':95'))).toBe(false);
    expect(production).toContain('https://ipfs.io');
  });
});
