import type { AnalysisErrorCode, KeyMoment, MatchAnalysis } from '@lms/protocol';

/**
 * Pure presentation for the analysis tab. Like `views.ts`, nothing here
 * touches the document; `screens/analysis.ts` applies it.
 *
 * Everything returned is plain text. The analysis is written by a model, so
 * it is put on the page with `textContent`, never parsed as markup.
 */

const KIND_ICONS: Record<KeyMoment['kind'], string> = {
  attack: '⚔️',
  hit: '💥',
  parry: '🛡️',
  evade: '🏃',
  defend: '🛡️',
  hide: '🏃',
  timeout: '⌛',
  eliminated: '☠️',
};

/** "Round 4 · #2 💥 #0": the checked part of a moment, ahead of its sentence. */
export function momentHeading(moment: KeyMoment): string {
  const target = moment.target === null ? '' : ` #${moment.target}`;
  return `Round ${moment.round} · #${moment.seat} ${KIND_ICONS[moment.kind]} ${moment.kind}${target}`;
}

/** The narrative split into paragraphs. */
export function paragraphs(summary: string): string[] {
  return summary
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/** The small print under an analysis: provenance, and what the verifier removed. */
export function analysisNote(analysis: MatchAnalysis, cached: boolean): string {
  const parts = [`Written by Gemini (${analysis.model}). Key moments are checked against the published rounds.`];
  if (analysis.dropped > 0) {
    parts.push(
      `${analysis.dropped} claim${analysis.dropped === 1 ? '' : 's'} the record did not support ${analysis.dropped === 1 ? 'was' : 'were'} removed.`,
    );
  }
  if (cached) parts.push('Saved from an earlier request.');
  return parts.join(' ');
}

/** What to tell the player, and whether trying again could help. */
export function errorText(code: AnalysisErrorCode, message: string): { text: string; retry: boolean } {
  switch (code) {
    case 'unavailable':
      return { text: 'Analysis is not available on this server.', retry: false };
    case 'forbidden':
      return { text: 'Only the players who sat in this match can analyse it.', retry: false };
    case 'not_found':
      return { text: 'The server has no record of this match yet. Try again in a moment.', retry: true };
    case 'quota':
      return { text: message, retry: false };
    default:
      return { text: message, retry: true };
  }
}
