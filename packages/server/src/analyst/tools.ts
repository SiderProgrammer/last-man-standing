import * as z from 'zod/v4';
import { Action, addressKey, type RoundRecord } from '@lms/consensus';
import type { StyleBook } from '../lobby/styles.js';
import type { ToolDefinition } from './model.js';
import type { ArchivedMatch } from '../lobby/store.js';
import { renderOverview, renderRound } from './prompt.js';

/**
 * The analyst's tools: read-only views of the one match being analysed.
 *
 * Bound to that match by the server, not chosen by the model. No tool takes a
 * match id or a wallet address, so nothing the model writes — and nothing a
 * player types into a follow-up question — can make it read another match or
 * look up a stranger's wallet. `get_player_history` takes a seat for exactly
 * that reason: it can only ever name a wallet that sat at this table.
 *
 * The definitions are constants in name order. They sit in the request's
 * fixed prefix with the system prompt, so building them per request, or in a
 * varying order, would cost the provider's prefix cache on every call.
 */
export const TOOLS: ToolDefinition[] = [
  tool(
    'get_match',
    'The match overview: rules, who sat where, the final ranking, and one line per round with eliminations and HP. Already in the first message; call it again only if it is no longer in view.',
    {},
  ),
  tool(
    'get_player_history',
    "A seat's wallet record across earlier settled matches: matches, wins, and how often it strikes, guards, charges or times out. Practice matches are not recorded.",
    { seat: { type: 'integer', description: 'Seat index in this match.' } },
  ),
  tool(
    'get_reads',
    "A seat's tendencies over this whole match, as the reads panel shows them: action counts, favourite target, strikes on the player the analysis is for, and the named tell if one stands out.",
    { seat: { type: 'integer', description: 'Seat index in this match.' } },
  ),
  tool(
    'get_round',
    "One round in full: every seat's move, every strike and its outcome (hit, guarded, void) with damage, heal, reflection and whether a Charge was behind it, the stall penalty, eliminations and HP afterwards. Check a round here before citing it as a key moment.",
    { round: { type: 'integer', description: 'Round number, starting at 1.' } },
  ),
];

/** Every property required, nothing extra allowed. The input is still checked on arrival — see `INPUTS`. */
function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>): ToolDefinition {
  return {
    name,
    description,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

/**
 * Inputs, checked again on arrival: a function call's arguments are model
 * output, and a provider's schema enforcement is not a guarantee.
 */
const INPUTS = {
  get_match: z.object({}).strict(),
  get_round: z.object({ round: z.number().int() }).strict(),
  get_reads: z.object({ seat: z.number().int() }).strict(),
  get_player_history: z.object({ seat: z.number().int() }).strict(),
} as const;

export type ToolName = keyof typeof INPUTS;

export interface ToolOutput {
  content: string;
  /** True for a bad call. The model sees the message and can correct itself. */
  isError: boolean;
}

/** Executes tool calls against one archived match. */
export class MatchTools {
  constructor(
    private readonly match: ArchivedMatch,
    /** Whose perspective "you" means in reads; null for a spectator. */
    private readonly you: number | null,
    private readonly styles?: StyleBook,
  ) {}

  /**
   * Everything the tools can say about this match, as one block of text for
   * the first message: every round in full, each seat's tendencies and its
   * record in earlier matches. With it the model can answer in a single call,
   * which matters when every call is slow or rationed.
   */
  async briefing(): Promise<string> {
    const lines = ['Every round in full:'];
    for (const record of this.match.history) lines.push(...renderRound(record));
    lines.push('', 'What each seat did over the whole match:');
    for (const seat of this.match.seats) lines.push(this.reads(seat.index).content);
    if (this.styles) {
      lines.push('', 'Earlier matches:');
      for (const seat of this.match.seats) lines.push((await this.career(seat.index)).content);
    }
    return lines.join('\n');
  }

  async run(name: string, input: unknown): Promise<ToolOutput> {
    if (!isToolName(name)) return failure(`there is no tool named ${name}`);
    const parsed = INPUTS[name].safeParse(input);
    if (!parsed.success) {
      return failure(`invalid input for ${name}: ${JSON.stringify(input)} (${parsed.error.issues[0]?.message})`);
    }
    switch (name) {
      case 'get_match':
        return success(renderOverview(this.match, this.you));
      case 'get_round':
        return this.round((parsed.data as { round: number }).round);
      case 'get_reads':
        return this.reads((parsed.data as { seat: number }).seat);
      case 'get_player_history':
        return this.career((parsed.data as { seat: number }).seat);
    }
  }

  private round(round: number): ToolOutput {
    const record = this.match.history.find((entry) => entry.round === round);
    if (!record) return failure(`round ${round} does not exist; the match had rounds 1 to ${this.match.history.length}`);
    return success(renderRound(record).join('\n'));
  }

  private reads(seat: number): ToolOutput {
    if (!this.seatExists(seat)) return failure(this.noSuchSeat(seat));
    const read = tendencies(this.match.history, seat, this.you);
    const parts = [
      `Seat #${seat} over the whole match: ${read.strikes} strikes, ${read.guards} guards, ${read.charges} charges, ${read.noShows} timeouts.`,
      read.favourite === null ? 'Never struck.' : `Struck #${read.favourite} most often.`,
    ];
    if (this.you !== null && seat !== this.you) {
      parts.push(`Struck #${this.you} (the player this analysis is for) ${read.againstYou} times.`);
    }
    const fell = this.match.history.find((record) => record.eliminated.includes(seat));
    parts.push(fell ? `Eliminated in round ${fell.round}.` : 'Still standing at the end.');
    return success(parts.join(' '));
  }

  private async career(seat: number): Promise<ToolOutput> {
    const entry = this.match.seats.find((candidate) => candidate.index === seat);
    if (!entry) return failure(this.noSuchSeat(seat));
    if (!this.styles) return success(`No match records are kept on this server.`);
    const style = (await this.styles.lookup([entry.address])).get(addressKey(entry.address));
    if (!style || style.matches === 0) return success(`Seat #${seat} has no settled matches on record.`);
    return success(
      `Seat #${seat} across ${style.matches} settled matches (this one included if it was staked): ${style.wins} won; ` +
        `${style.strikes} strikes, ${style.guards} guards, ${style.charges} charges, ${style.noShows} timeouts.`,
    );
  }

  private seatExists(seat: number): boolean {
    return this.match.seats.some((entry) => entry.index === seat);
  }

  private noSuchSeat(seat: number): string {
    return `seat ${seat} does not exist; seats are 0 to ${this.match.seats.length - 1}`;
  }
}

/**
 * What one seat did over the match: counts, its most frequent target, and how
 * often it struck `you`. Plain counts; spotting the pattern in them is the
 * model's job.
 */
function tendencies(history: readonly RoundRecord[], seat: number, you: number | null) {
  const read = { strikes: 0, guards: 0, charges: 0, noShows: 0, favourite: null as number | null, againstYou: 0 };
  const targets = new Map<number, number>();
  for (const record of history) {
    const move = record.moves.find((entry) => entry.index === seat);
    if (!move) continue;
    if (!move.revealed) read.noShows += 1;
    else if (move.action === Action.Guard) read.guards += 1;
    else if (move.action === Action.Charge) read.charges += 1;
    else if (move.action === Action.Strike) {
      read.strikes += 1;
      if (move.target === you) read.againstYou += 1;
      targets.set(move.target, (targets.get(move.target) ?? 0) + 1);
    }
  }
  const [best] = [...targets.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (best) read.favourite = best[0];
  return read;
}

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(INPUTS, name);
}

function success(content: string): ToolOutput {
  return { content, isError: false };
}

function failure(content: string): ToolOutput {
  return { content, isError: true };
}

