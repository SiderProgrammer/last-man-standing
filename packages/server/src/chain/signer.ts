import { toAccount, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, LocalAccount, SerializeTransactionFn, TransactionSerializable, TypedDataDefinition } from 'viem';

/**
 * A key the server signs with, by what it can sign rather than what it is.
 *
 * Everything that signs — the attestor's results and receipts, every
 * transaction a `TxSender` sends — goes through one of these, never a raw
 * private key, so a key can move into a KMS or an HSM by implementing this
 * and nothing else. `keySigner` is the in-memory one every key uses today.
 */
export interface Signer {
  readonly address: Address;
  signMessage(message: string): Promise<Hex>;
  signTypedData(data: TypedDataDefinition): Promise<Hex>;
  signTransaction(transaction: TransactionSerializable, serializer?: SerializeTransactionFn): Promise<Hex>;
}

/** A signer over a private key held in this process's memory. */
export function keySigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (data) => account.signTypedData(data),
    signTransaction: (transaction, serializer) =>
      account.signTransaction(transaction, serializer ? { serializer } : undefined),
  };
}

/** `signer` as a viem account, for a wallet client to send with. */
export function signerAccount(signer: Signer): LocalAccount {
  return toAccount({
    address: signer.address,
    signMessage: ({ message }) => signer.signMessage(typeof message === 'string' ? message : String(message.raw)),
    signTypedData: (data) => signer.signTypedData(data as TypedDataDefinition),
    signTransaction: (transaction, options) => signer.signTransaction(transaction, options?.serializer),
  });
}
