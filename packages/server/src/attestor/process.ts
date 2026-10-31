/**
 * The attestor's own process, forked by `AttestorProcess`. It holds the
 * attestor key and nothing else of the server's: no socket, no database, no
 * other key. It answers `attest`, `abort` and `receipt` over IPC, and replays
 * every transcript before it signs one.
 *
 * Configured by its environment, which the parent builds: `ATTESTOR_PK`,
 * `CHAIN_ID`, `ESCROW_ADDRESS`, and `RPC_URL` to check transcripts against
 * the escrow.
 */
import { errorMessage } from '@lms/protocol';
import { keySigner } from '../chain/signer.js';
import { Rpc } from '../util/rpc.js';
import { AttestorService, escrowMatchReader } from './service.js';

const env = process.env;
const key = env.ATTESTOR_PK;
const chainId = Number(env.CHAIN_ID);
const escrow = env.ESCROW_ADDRESS as `0x${string}` | undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key) || !Number.isInteger(chainId) || !escrow) {
  console.error('[attestor] needs ATTESTOR_PK, CHAIN_ID and ESCROW_ADDRESS');
  process.exit(1);
}

const service = new AttestorService({
  signer: keySigner(key as `0x${string}`),
  chainId,
  escrow,
  ...(env.RPC_URL ? { chain: escrowMatchReader({ rpcUrl: env.RPC_URL, chainId, escrow }) } : {}),
});

const send = process.send?.bind(process);
if (!send) {
  console.error('[attestor] must be started by the server, over IPC');
  process.exit(1);
}

const rpc = new Rpc(
  { send: (message) => void send(message), listen: (listener) => void process.on('message', listener) },
  {
    attest: async (transcript: Parameters<AttestorService['attest']>[0]) => {
      try {
        return await service.attest(transcript);
      } catch (error) {
        console.warn('[attestor] refused:', errorMessage(error));
        throw error;
      }
    },
    abort: (matchId: `0x${string}`) => service.abort(matchId),
    receipt: (receipt: Parameters<AttestorService['receipt']>[0]) => service.receipt(receipt),
  },
);
rpc.emit('ready', service.address);
// The server went away: so does its attestor.
process.on('disconnect', () => process.exit(0));
