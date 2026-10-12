import { describe, expect, it } from 'vitest';
import { buildAirdrop } from '@lms/protocol';
import { airdropResponse, parseAirdropFile } from '@lms/server';

const A1 = '0x00000000000000000000000000000000000000A1' as const;
const A2 = '0x00000000000000000000000000000000000000A2' as const;

/** The file exactly as `scripts/airdrop.mjs` writes it. */
function file(): string {
  const airdrop = buildAirdrop(
    new Map([
      [A1, 100n],
      [A2, 250n],
    ]),
  );
  return JSON.stringify({ escrow: A1, ...airdrop }, (_, value) => (typeof value === 'bigint' ? value.toString() : value));
}

describe('parseAirdropFile', () => {
  it('looks claims up by address, in any casing', () => {
    const book = parseAirdropFile(file());

    expect(book.size).toBe(2);
    expect(book.lookup(A2.toLowerCase())).toMatchObject({ amount: '250' });
    expect(book.lookup(A1)?.proof).toHaveLength(1);
    expect(book.lookup(`0x${'ff'.repeat(20)}`)).toBeNull();
    expect(book.lookup('not an address')).toBeNull();
  });

  it('rejects a malformed file at boot rather than serving garbage', () => {
    const good = JSON.parse(file());
    expect(() => parseAirdropFile('[]')).toThrow();
    expect(() => parseAirdropFile(JSON.stringify({ ...good, root: '0x12' }))).toThrow(/root/);
    expect(() =>
      parseAirdropFile(JSON.stringify({ ...good, claims: { [A1]: { amount: '-1', proof: [] } } })),
    ).toThrow(/amount/);
    expect(() =>
      parseAirdropFile(JSON.stringify({ ...good, claims: { [A1]: { amount: '1', proof: ['0x01'] } } })),
    ).toThrow(/proof/);
    expect(() => parseAirdropFile(JSON.stringify({ ...good, claims: { nope: { amount: '1', proof: [] } } }))).toThrow(
      /address/,
    );
  });
});

describe('airdropResponse', () => {
  const book = parseAirdropFile(file());

  it('answers an address with its allocation', () => {
    const response = airdropResponse(book, `/airdrop/${A2}`);

    expect(response?.status).toBe(200);
    expect(JSON.parse(response!.body)).toMatchObject({ amount: '250' });
  });

  it('404s for an address with nothing, and when there is no airdrop at all', () => {
    expect(airdropResponse(book, `/airdrop/0x${'ff'.repeat(20)}`)?.status).toBe(404);
    expect(airdropResponse(null, `/airdrop/${A1}`)?.status).toBe(404);
  });

  it('ignores every other path, including malformed addresses', () => {
    expect(airdropResponse(book, '/health')).toBeNull();
    expect(airdropResponse(book, '/airdrop/0x123')).toBeNull();
    expect(airdropResponse(book, `/airdrop/${A1}?x=1`)?.status).toBe(200);
  });
});
