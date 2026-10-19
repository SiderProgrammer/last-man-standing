import * as z from 'zod/v4';
import { KEY_MOMENT_KINDS } from '@lms/protocol';

/**
 * The shape the model must answer in.
 *
 * Sent to the API as a structured-output format, so the reply is constrained
 * to it while it is generated, and parsed again with the same schema on
 * arrival: the API's JSON Schema subset cannot express every bound below
 * (lengths, minimums), and an answer is never trusted because of where it
 * came from. Field order matters — `summary` comes first so the narrative
 * starts streaming before the model has settled on the moments.
 */
export const AnalysisOutput = z.object({
  summary: z
    .string()
    .min(1)
    .max(4_000)
    .describe('Two or three short paragraphs telling the story of the match, in plain prose.'),
  decisiveRound: z
    .number()
    .int()
    .nullable()
    .describe('The round that decided the match, or null if no single round did.'),
  keyMoments: z
    .array(
      z.object({
        round: z.number().int().describe('Round number, starting at 1.'),
        seat: z.number().int().describe('Seat index the moment is about.'),
        kind: z.enum(KEY_MOMENT_KINDS),
        target: z
          .number()
          .int()
          .nullable()
          .describe('The other seat, for attack/hit/parry/evade; null for every other kind.'),
        claim: z.string().min(1).max(300).describe('One sentence explaining why the moment mattered.'),
      }),
    )
    .max(8)
    .describe('Three to six moments that shaped the match, in round order.'),
  advice: z
    .array(z.string().min(1).max(400))
    .max(4)
    .describe('Two to four concrete, actionable tips for the player the analysis is written for.'),
});

export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

/** Thrown when the model's final answer is not valid JSON of the right shape. */
export class MalformedAnalysisError extends Error {}

export function parseAnalysisOutput(text: string): AnalysisOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MalformedAnalysisError('the model answered with text that is not JSON');
  }
  const parsed = AnalysisOutput.safeParse(json);
  if (!parsed.success) {
    throw new MalformedAnalysisError(`the model's answer does not match the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/**
 * `AnalysisOutput` as JSON Schema, in the subset a provider's structured
 * output accepts: no `$schema`, no string lengths and no unbounded integer
 * ranges. The bounds are not lost — `parseAnalysisOutput` enforces them all.
 */
export function outputSchema(): Record<string, unknown> {
  return strip(z.toJSONSchema(AnalysisOutput)) as Record<string, unknown>;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === 'minLength' || key === 'maxLength') continue;
    if ((key === 'minimum' || key === 'maximum') && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER) continue;
    out[key] = strip(value);
  }
  return out;
}
