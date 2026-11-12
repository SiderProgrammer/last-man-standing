import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult, parseEther } from 'viem';
import { contractErrorsAbi, gameEscrowAbi } from '@lms/contracts';
import { explainError } from '../src/ui/errors.js';

/** A revert as viem reports it when the call's own ABI does not know the error. */
function unknownRevert(data: `0x${string}`): BaseError {
  return new ContractFunctionRevertedError({ abi: gameEscrowAbi, data, functionName: 'join' });
}

describe('explainError', () => {
  it('decodes an error the call’s own ABI did not know, from any of our contracts', () => {
    const data = encodeErrorResult({ abi: contractErrorsAbi, errorName: 'InvalidSession' });
    expect(explainError(unknownRevert(data))).toMatch(/one-click session is not valid/);
  });

  it('says how much LMS the wallet holds when it is short', () => {
    const data = encodeErrorResult({
      abi: contractErrorsAbi,
      errorName: 'ERC20InsufficientBalance',
      args: [`0x${'aa'.repeat(20)}`, parseEther('50000'), parseEther('60000')],
    });
    expect(explainError(unknownRevert(data))).toBe('You hold 50,000 LMS, less than the 60,000 LMS this needs.');
  });

  it('names an error it has no words for', () => {
    const data = encodeErrorResult({ abi: contractErrorsAbi, errorName: 'PayoutScheduleEmpty' });
    expect(explainError(unknownRevert(data))).toBe('The transaction would fail: Payout schedule empty.');
  });

  it('says plainly that the player cancelled in the wallet', () => {
    const error = new BaseError('request failed', { cause: new UserRejectedRequestError(new Error('User rejected')) });
    expect(explainError(error)).toBe('You cancelled it in your wallet.');
  });

  it('falls back to the first line of anything else', () => {
    expect(explainError(new Error('first\nsecond'))).toBe('first');
  });
});
