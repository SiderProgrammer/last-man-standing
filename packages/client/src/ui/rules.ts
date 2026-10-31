import { BPS_DENOMINATOR, exposedDamage, stallDamageFor, strikeDamageFor, strikeHeal, type Rules } from '@lms/consensus';

/** One titled block of the rules sheet. */
export interface RulesSection {
  title: string;
  /** Tone of the section's accent, matching the action buttons. */
  tone?: 'strike' | 'guard' | 'charge' | 'stall';
  lines: string[];
}

/**
 * The rules sheet, written from the numbers a match actually runs under rather
 * than hard-coded, so it cannot drift from the kernel when the rules change.
 */
export function rulesSheet(rules: Rules): RulesSection[] {
  const hit = strikeDamageFor(rules, false);
  const loaded = strikeDamageFor(rules, true);
  const stallExamples = [0, 1, 2]
    .map((extra) => rules.stallGraceRounds + extra)
    .map((quiet) => `${quiet} quiet rounds: ${stallDamageFor(rules, quiet)}`)
    .join(' · ');

  return [
    {
      title: 'The goal',
      lines: [
        `${rules.minPlayers}–${rules.maxPlayers} seats, ${rules.startingHp} HP each. Be the last one standing.`,
        'Every round, everyone picks one action in secret. Moves are revealed together and resolve at the same time, so nobody acts first.',
        'Strike beats Charge, Guard beats Strike, Charge beats Guard.',
      ],
    },
    {
      title: 'Strike',
      tone: 'strike',
      lines: [
        `Hit one other seat for ${hit} damage. A hit that lands heals you ${percent(rules.strikeHealBps)} of it (${strikeHeal(rules, hit)} HP), never above ${rules.startingHp}.`,
        'Your hit lands even if you are knocked out in the same round.',
      ],
    },
    {
      title: 'Guard',
      tone: 'guard',
      lines: [
        `Block one strike aimed at you and send ${rules.guardReflectDamage} damage back to that striker.`,
        'With several strikers, the one you block is picked at random. The rest still hit you.',
        'You cannot Guard two rounds in a row.',
      ],
    },
    {
      title: 'Charge',
      tone: 'charge',
      lines: [
        `Load your next Strike: it hits for ${loaded} instead of ${hit}. Everyone can see you are charged.`,
        `While you charge, strikes on you hit ${percent(rules.chargeExposureBps)} harder (${exposedDamage(rules, hit)} instead of ${hit}).`,
        'You cannot Charge two rounds in a row, or while a Charge is already loaded.',
      ],
    },
    {
      title: 'The stall penalty',
      tone: 'stall',
      lines: [
        `Once ${rules.stallGraceRounds} rounds pass in a row without anyone landing anything, every living seat takes damage, more for every further quiet round: ${stallExamples}, …`,
        'Any hit, a Guard’s reflection included, resets it. It only stops a table that stops fighting.',
      ],
    },
    {
      title: 'Missing the timer',
      lines: ['No move locked in, or a move your cooldown rules out, means no action: every strike on you hits.'],
    },
    {
      title: 'Elimination and ranking',
      lines: [
        'A seat at 0 HP or below is out at the end of the round.',
        'If a round would knock out everyone left, the seat with the least overkill survives on 1 HP. An exact tie goes to the round’s random draw. There is always exactly one winner.',
        `After ${rules.maxRounds} rounds the match ends anyway, and survivors rank by HP. Everyone else ranks by how long they lasted.`,
      ],
    },
  ];
}

function percent(bps: number): string {
  return `${Math.round((bps * 100) / BPS_DENOMINATOR)}%`;
}
