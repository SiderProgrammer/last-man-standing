import { AttackOutcome, type KeyMoment, type RoundRecord } from '@lms/protocol';
import type { MatchArchive } from '../lobby/store.js';
import type { AnalystModel, ContentBlock, ModelReply } from './model.js';

/**
 * A stand-in model that needs no API key and costs nothing: it answers from
 * the archived match with a few fixed rules instead of calling a model.
 *
 * For UI work and demos only (`ANALYST_DEMO=true`). It goes through the real
 * pipeline — one tool turn so `analysis.step` frames show, a streamed JSON
 * answer, the schema check and the claim verifier — and it deliberately adds
 * one claim the history does not support, so the verifier visibly drops it.
 * The prose is formulaic; nobody should mistake it for an analysis.
 */
export function demoModel(archive: MatchArchive, options: { chunkDelayMs?: number } = {}): AnalystModel {
  const delay = options.chunkDelayMs ?? 25;
  return {
    async stream(request, onText, signal) {
      // A follow-up question: no answer schema. The demo cannot discuss anything, and says so.
      if (!request.output_schema) {
        const text =
          'The offline demo analyst cannot answer questions. With GEMINI_API_KEY set on the server, ' +
          'Gemini answers here, using the same tools to look up the rounds you ask about.';
        await play(text, onText, signal, delay);
        return reply([{ type: 'text', text }], 'end_turn');
      }

      const opening = request.messages[0]?.content;
      const matchId = typeof opening === 'string' ? /Match (0x[0-9a-fA-F]{64})/.exec(opening)?.[1] : undefined;
      const match = matchId ? await archive.load(matchId as `0x${string}`) : null;
      if (!match) throw new Error('demo model: the opening message names no archived match');
      const seat = /seat #(\d+)/.exec(String(opening))?.[1];
      const decisive = decisiveRound(match.history);

      // First turn: look something up, as the real model would.
      if (request.messages.length === 1) {
        const content = [
          { type: 'tool_use', id: 'demo_round', name: 'get_round', input: { round: decisive } },
          { type: 'tool_use', id: 'demo_reads', name: 'get_reads', input: { seat: winnerSeat(match.history) } },
        ] satisfies ContentBlock[];
        return reply(content, 'tool_use');
      }

      const text = JSON.stringify(answer(match.history, decisive, seat === undefined ? null : Number(seat)));
      await play(text, onText, signal, delay);
      return reply([{ type: 'text', text }], 'end_turn');
    },
  };
}

/** Streams `text` in small pieces, as a model would. */
async function play(text: string, onText: (delta: string) => void, signal: AbortSignal, delay: number): Promise<void> {
  for (let i = 0; i < text.length; i += 12) {
    if (signal.aborted) throw new Error('aborted');
    onText(text.slice(i, i + 12));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function answer(history: readonly RoundRecord[], decisive: number, you: number | null) {
  const winner = winnerSeat(history);
  const eliminations = history.flatMap((record) => record.eliminated.map((seat) => ({ round: record.round, seat })));
  const moments: KeyMoment[] = [];

  const firstHit = history.flatMap((record) =>
    record.attacks.filter((attack) => attack.outcome === AttackOutcome.Hit).map((attack) => ({ record, attack })),
  )[0];
  if (firstHit) {
    moments.push({
      round: firstHit.record.round,
      seat: firstHit.attack.attacker,
      kind: 'hit',
      target: firstHit.attack.target,
      claim: `First blood: #${firstHit.attack.attacker} landed ${firstHit.attack.damage} on #${firstHit.attack.target}.`,
    });
  }
  for (const out of eliminations.slice(0, 3)) {
    moments.push({ ...out, kind: 'eliminated', target: null, claim: `#${out.seat} went out in round ${out.round}.` });
  }
  // Deliberately false, so the verifier has something to drop in a demo.
  moments.push({
    round: history.length + 1,
    seat: winner,
    kind: 'attack',
    target: winner,
    claim: 'This claim is made up on purpose and should never reach the screen.',
  });

  return {
    summary:
      `This is the offline demo analyst, not a real model: it describes the match from fixed rules.\n\n` +
      `The match ran ${history.length} rounds. ${eliminations.length} seats were eliminated, ` +
      `and #${winner} was the last one standing. Round ${decisive} was where the field thinned the most.`,
    decisiveRound: decisive,
    keyMoments: moments,
    advice: [
      you === null
        ? 'Watch which seat the table piles onto; defending against focus fire only parries one attacker.'
        : `As #${you}, open the Reads tab after round three: the tells are there before the storm gets serious.`,
      'Set GEMINI_API_KEY on the server to get a real analysis.',
    ],
  };
}

/** The round with the most eliminations, earliest first. */
function decisiveRound(history: readonly RoundRecord[]): number {
  let best = history[0]?.round ?? 1;
  let most = -1;
  for (const record of history) {
    if (record.eliminated.length > most) {
      most = record.eliminated.length;
      best = record.round;
    }
  }
  return best;
}

/** The seat still standing after the last round, or seat 0 if none is. */
function winnerSeat(history: readonly RoundRecord[]): number {
  const last = history[history.length - 1];
  if (!last) return 0;
  const out = new Set(history.flatMap((record) => record.eliminated));
  return last.moves.map((move) => move.index).find((seat) => !out.has(seat)) ?? 0;
}

function reply(content: ContentBlock[], stop: 'tool_use' | 'end_turn'): ModelReply {
  return {
    id: `demo_${Date.now()}`,
    model: 'demo',
    content,
    stop_reason: stop,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  };
}
