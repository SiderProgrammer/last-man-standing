import * as z from 'zod/v4';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { addressKey, describeStyle, readOpponents, type ReadTable } from '@lms/protocol';
import type { StyleBook } from '../lobby/styles.js';
import { renderOverview, renderRound, type SeatedMatch } from './prompt.js';

/**
 * The analyst's tools: read-only views of the one match being analysed.
 *
 * Bound to that match by the server, not chosen by the model. No tool takes a
 * match id or a wallet address, so nothing the model writes — and nothing a
 * player types into a follow-up question — can make it read another match or
 * look up a stranger's wallet. `get_player_history` takes a seat for exactly
 * that reason: it can only ever name a wallet that sat at this table.
 *
 * The definitions are constants in name order. Tools render first in a
 * request, ahead of the system prompt, so they are part of the cached prefix:
 * building them per request, or in a varying order, would cost a cache write
 * on every call.
 */
export const TOOLS: BetaTool[] = [
  tool(
    'get_match',
    'The match overview: rules, who sat where, the final ranking, and one line per round with eliminations and HP. Already in the first message; call it again only if it is no longer in view.',
    {},
  ),
  tool(
    'get_player_history',
    "A seat's wallet record across earlier settled matches: matches, wins, and how often it attacks, defends, hides or times out. Practice matches are not recorded.",
    { seat: { type: 'integer', description: 'Seat index in this match.' } },
  ),
  tool(
    'get_reads',
    "A seat's tendencies over this whole match, as the reads panel shows them: action counts, favourite target, attacks on the player the analysis is for, and the named tell if one stands out.",
    { seat: { type: 'integer', description: 'Seat index in this match.' } },
  ),
  tool(
    'get_round',
    "One round in full: every seat's move, every attack and its outcome (hit, parried, missed, void) with damage and riposte, the storm, eliminations and HP afterwards. Check a round here before citing it as a key moment.",
    { round: { type: 'integer', description: 'Round number, starting at 1.' } },
  ),
];

/**
 * A strict tool: every property required, nothing extra allowed, so the API
 * constrains the call to the schema. Inputs stream eagerly, which means they
 * arrive unvalidated — see `INPUTS`.
 */
function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>): BetaTool {
  return {
    name,
    description,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    strict: true,
    eager_input_streaming: true,
  };
}

/**
 * Inputs, checked again on arrival. With eager input streaming the API no
 * longer validates tool input before handing it over, and the SDK's tolerant
 * parser can return a silently truncated object instead of failing.
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
  private readonly table: ReadTable;

  constructor(
    private readonly match: SeatedMatch,
    /** Whose perspective "you" means in reads; null for a spectator. */
    private readonly you: number | null,
    private readonly styles?: StyleBook,
  ) {
    const eliminated = new Set(match.history.flatMap((record) => record.eliminated));
    this.table = {
      players: match.seats.map((seat) => ({
        index: seat.index,
        address: seat.address,
        alive: !eliminated.has(seat.index),
      })),
      history: match.history,
    };
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
    // `readOpponents` leaves out the reader's own seat, so a seat asking
    // about itself is read from nobody's perspective.
    const perspective = seat === this.you ? null : this.you;
    const read = readOpponents(this.table, perspective).find((entry) => entry.seat === seat);
    if (!read) return failure(this.noSuchSeat(seat));

    const parts = [
      `Seat #${seat} over the whole match: ${read.attacks} attacks, ${read.defends} defends, ${read.hides} hides, ${read.noShows} timeouts.`,
      read.favourite === null ? 'Never attacked.' : `Attacked #${read.favourite} most often.`,
    ];
    if (perspective !== null) parts.push(`Attacked #${perspective} (the player this analysis is for) ${read.againstYou} times.`);
    parts.push(read.tell ? `Tell: ${read.tell}.` : 'No tell stands out.');
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
        `${style.attacks} attacks, ${style.defends} defends, ${style.hides} hides, ${style.noShows} timeouts. ` +
        `Summary: ${describeStyle(style)}`,
    );
  }

  private seatExists(seat: number): boolean {
    return this.table.players.some((player) => player.index === seat);
  }

  private noSuchSeat(seat: number): string {
    return `seat ${seat} does not exist; seats are 0 to ${this.table.players.length - 1}`;
  }
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

