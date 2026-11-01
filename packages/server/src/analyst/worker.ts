/**
 * The analyst's own thread, started by `AnalystWorker`.
 *
 * Everything an analysis does — rendering the prompt, the model call,
 * parsing and checking the answer — runs here, off the event loop
 * that runs the rooms' clocks. Its limits live here too. The matches it reads
 * and the analyses it caches stay in the server: each read is a call back
 * over the port.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { MatchAnalysis, PlayStyle } from '@lms/api';
import type { ArchivedAnalysis, ArchivedMatch, MatchArchive } from '../lobby/store.js';
import type { StyleBook } from '../lobby/styles.js';
import { Rpc } from '../util/rpc.js';
import { Analyst, type AnalyzeResult } from './analyst.js';
import { geminiModel } from './gemini.js';
import { AnalystLimits } from './limits.js';
import type { AnalystWorkerConfig } from './remote.js';

const port = parentPort;
if (!port) throw new Error('the analyst worker must run in a worker thread');
const config = workerData as AnalystWorkerConfig;

const controllers = new Map<number, AbortController>();
const rpc = new Rpc(
  { send: (message) => port.postMessage(message), listen: (listener) => void port.on('message', listener) },
  {
    analyze: async (id: number, request: { matchId: `0x${string}`; requester: `0x${string}` }): Promise<AnalyzeResult> => {
      const controller = new AbortController();
      controllers.set(id, controller);
      try {
        return await analyst.analyze({
          ...request,
          signal: controller.signal,
          onStep: (step) => rpc.emit('step', { id, step }),
        });
      } finally {
        controllers.delete(id);
        report();
      }
    },
  },
);
rpc.on('abort', (id) => controllers.get(id as number)?.abort());

/** Reads only: the analyst never writes a match, only its own analyses. */
const archive: Pick<MatchArchive, 'load' | 'loadAnalysis' | 'saveAnalysis'> = {
  load: (matchId) => rpc.call<ArchivedMatch | null>('archive.load', matchId),
  loadAnalysis: (matchId, seat, version) => rpc.call<MatchAnalysis | null>('archive.loadAnalysis', matchId, seat, version),
  saveAnalysis: (entry: ArchivedAnalysis) => rpc.call<void>('archive.saveAnalysis', entry),
};
const styles: Pick<StyleBook, 'lookup'> = {
  lookup: (addresses) => rpc.call<Map<string, PlayStyle>>('styles.lookup', addresses),
};

const limits = new AnalystLimits(config.limits);
const analyst = new Analyst({
  ...config.analyst,
  archive: archive as MatchArchive,
  styles: styles as StyleBook,
  model: geminiModel(config.model),
  limits,
});

let last = '';
/** Tells the server the day's usage, for `/health`, whenever it changes. */
function report(): void {
  const stats = { requests: limits.requests, spent: limits.spent };
  const key = `${stats.requests}:${stats.spent}`;
  if (key === last) return;
  last = key;
  rpc.emit('stats', stats);
}

setInterval(() => {
  limits.sweep(Date.now());
  report();
}, 1_000).unref();
