import { describe, expect, it } from 'vitest';
import { keccak256, recoverTypedDataAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MATCH_RESULT_TYPES, matchResultDomain, type AttestedResult } from '@lms/protocol';
import { packSignatures, signResult } from '@lms/server';

const ESCROW = '0x000000000000000000000000000000000000e5c0' as const;
const CHAIN_ID = 11155111;

const result: AttestedResult = {
  matchId: keccak256(toHex('match')),
  rounds: 7,
  historyRoot: keccak256(toHex('history')),
  transcriptHash: keccak256(toHex('transcript')),
  ranking: [
    '0x00000000000000000000000000000000000000a1',
    '0x00000000000000000000000000000000000000b2',
    '0x00000000000000000000000000000000000000c3',
    '0x00000000000000000000000000000000000000d4',
  ],
};

describe('attestation', () => {
  it('produces a signature that recovers to the attestor', async () => {
    const key = `0x${'22'.repeat(32)}` as const;
    const signature = await signResult(key, result, CHAIN_ID, ESCROW);

    const recovered = await recoverTypedDataAddress({
      domain: matchResultDomain(CHAIN_ID, ESCROW),
      types: MATCH_RESULT_TYPES,
      primaryType: 'MatchResult',
      message: result,
      signature,
    });
    expect(recovered).toBe(privateKeyToAccount(key).address);
  });

  it('binds the signature to the escrow and the chain', async () => {
    const key = `0x${'33'.repeat(32)}` as const;
    const onHub = await signResult(key, result, CHAIN_ID, ESCROW);
    const onOtherChain = await signResult(key, result, 421_614, ESCROW);
    const onOtherEscrow = await signResult(
      key,
      result,
      CHAIN_ID,
      '0x000000000000000000000000000000000000dead',
    );

    expect(onHub).not.toBe(onOtherChain);
    expect(onHub).not.toBe(onOtherEscrow);
  });

  it('binds the signature to the transcript', async () => {
    const key = `0x${'44'.repeat(32)}` as const;
    const signed = await signResult(key, result, CHAIN_ID, ESCROW);
    const other = await signResult(key, { ...result, transcriptHash: keccak256(toHex('another')) }, CHAIN_ID, ESCROW);
    expect(signed).not.toBe(other);
  });

  it('packs signatures in ascending signer order', () => {
    const packed = packSignatures([
      { signer: '0x00000000000000000000000000000000000000ff', signature: `0x${'bb'.repeat(65)}` },
      { signer: '0x0000000000000000000000000000000000000011', signature: `0x${'aa'.repeat(65)}` },
    ]);

    // `SignatureLib.recoverAscending` requires this ordering to reject duplicates.
    expect(packed).toBe(`0x${'aa'.repeat(65)}${'bb'.repeat(65)}`);
    expect((packed.length - 2) / 2 / 65).toBe(2);
  });
});
