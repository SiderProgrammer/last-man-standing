import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchivedAnalysis, MatchArchive } from '../lobby/store.js';
import type { StyleBook } from '../lobby/styles.js';
import { RemoteError, Rpc } from '../util/rpc.js';
import { AnalystError, type AnalystOptions, type AnalyzeRequest, type AnalyzeResult, type MatchAnalyst } from './analyst.js';
import type { GeminiModelOptions } from './gemini.js';
import type { AnalystLimitOptions } from './limits.js';
import type { AnalysisErrorCode } from '@lms/protocol';

/** What the worker builds its analyst from. Plain data, to cross the thread boundary. */
export interface AnalystWorkerConfig {
  model: GeminiModelOptions;
  analyst: Pick<AnalystOptions, 'modelId' | 'effort' | 'maxTokens' | 'deadlineMs' | 'maxTurns'>;
  limits: AnalystLimitOptions;
}

/**
 * The analyst, run in a worker thread (`analyst/worker.ts`).
 *
 * The gateway sees an ordinary `MatchAnalyst`. Behind it each analysis is a
 * call into the worker, its progress comes back as `step` events, and the
 * worker's reads of the archive and style book are answered here, from the
 * server's own. A worker that dies is started again on the next request.
 */
export class AnalystWorker implements MatchAnalyst {
  private worker: Worker | null = null;
  private rpc: Rpc | null = null;
  private next = 1;
  private readonly steps = new Map<number, (step: string) => void>();
  private stats = { requests: 0, spent: 0 };

  constructor(
    private readonly options: { config: AnalystWorkerConfig; archive: MatchArchive; styles?: StyleBook },
  ) {}

  /** Model requests made today, as the worker last reported. */
  get requests(): number {
    return this.stats.requests;
  }

  /** Estimated US dollars spent today, as the worker last reported. */
  get spent(): number {
    return this.stats.spent;
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResult> {
    const rpc = this.rpc ?? this.start();
    const id = this.next++;
    if (request.onStep) this.steps.set(id, request.onStep);
    const abort = () => rpc.emit('abort', id);
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      return await rpc.call<AnalyzeResult>('analyze', id, { matchId: request.matchId, requester: request.requester });
    } catch (error) {
      if (error instanceof RemoteError && error.name === 'AnalystError') {
        throw new AnalystError(error.code as AnalysisErrorCode, error.message);
      }
      throw error;
    } finally {
      this.steps.delete(id);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.rpc = null;
    await worker?.terminate();
  }

  private start(): Rpc {
    const here = fileURLToPath(import.meta.url);
    const entry = here.replace(/remote(\.[cm]?[jt]s)$/, 'worker$1');
    const worker = new Worker(entry, {
      workerData: this.options.config,
      execArgv: extname(entry) === '.ts' ? ['--import', 'tsx'] : [],
    });
    const { archive, styles } = this.options;
    const rpc = new Rpc(
      { send: (message) => worker.postMessage(message), listen: (listener) => void worker.on('message', listener) },
      {
        'archive.load': (matchId: `0x${string}`) => archive.load(matchId),
        'archive.loadAnalysis': (matchId: `0x${string}`, seat: number | null, version: string) =>
          archive.loadAnalysis(matchId, seat, version),
        'archive.saveAnalysis': (entry: ArchivedAnalysis) => archive.saveAnalysis(entry),
        'styles.lookup': (addresses: `0x${string}`[]) => styles?.lookup(addresses) ?? new Map(),
      },
    );
    rpc.on('step', (payload) => {
      const { id, step } = payload as { id: number; step: string };
      this.steps.get(id)?.(step);
    });
    rpc.on('stats', (payload) => {
      this.stats = payload as { requests: number; spent: number };
    });
    const lost = (reason: string) => {
      rpc.failAll(new AnalystError('failed', `the analyst stopped: ${reason}`));
      if (this.rpc === rpc) {
        this.rpc = null;
        this.worker = null;
      }
    };
    worker.on('error', (error) => {
      console.error('[analyst] worker failed:', error.message);
      lost(error.message);
    });
    worker.on('exit', (code) => lost(`exit ${code}`));
    worker.unref();
    this.worker = worker;
    this.rpc = rpc;
    return rpc;
  }
}
