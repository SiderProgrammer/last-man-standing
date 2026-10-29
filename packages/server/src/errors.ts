import type { ErrorCode } from '@lms/protocol';

/**
 * A request the server refuses, with the code the client switches on. The
 * message is for people; the code is the contract.
 */
export class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}
