import { BPS_DENOMINATOR, stormDamageForRound, type Rules } from '@lms/protocol';

/** One titled block of the rules sheet. */
export interface RulesSection {
  title: string;
  /** Tone of the section's accent, matching the action buttons. */
  tone?: 'attack' | 'defend' | 'hide' | 'storm';
  lines: string[];
}

/**
 * The rules sheet, written from the numbers a match actually runs under rather
 * than hard-coded, so it cannot drift from the kernel when the rules change.
 */
export function rulesSheet(rules: Rules): RulesSection[] {
  const evade = percent(rules.hideEvadeBps);
  const hiddenStorm = percent(rules.hideStormBps);
  const firstStormRound = rules.stormGraceRounds + 1;
  const stormExamples = [0, 1, 2, 4]
    .map((offset) => firstStormRound + offset)
    .map((round) => `round ${round}: ${stormDamageForRound(rules, round)}`)
    .join(' · ');

  return [
    {
      title: 'The goal',
      lines: [
        `${rules.minPlayers}–${rules.maxPlayers} seats, ${rules.startingHp} HP each. Be the last one standing.`,
        'Every round, everyone picks one action in secret. Moves are revealed together and resolve at the same time, so nobody acts first.',
      ],
    },
    {
      title: 'Attack',
      tone: 'attack',
      lines: [
        `Strike one other seat for ${rules.attackDamage} damage.`,
        'Your hit lands even if you are knocked out in the same round.',
      ],
    },
    {
      title: 'Defend',
      tone: 'defend',
      lines: [
        `Parry one attacker: they take ${rules.riposteDamage} riposte damage and you take nothing from them.`,
        'With several attackers, the one you parry is picked at random. The rest still hit you.',
      ],
    },
    {
      title: 'Hide',
      tone: 'hide',
      lines: [
        `Each attack on you has a ${evade} chance to miss.`,
        `You take only ${hiddenStorm} of the storm damage.`,
      ],
    },
    {
      title: 'The storm',
      tone: 'storm',
      lines: [
        `From round ${firstStormRound} the storm hits every living seat, harder each round: ${stormExamples}, …`,
        'It keeps everyone from turtling forever.',
      ],
    },
    {
      title: 'Missing the timer',
      lines: [
        'No move locked in means no action: every attack on you hits and you take the full storm.',
      ],
    },
    {
      title: 'Elimination and ranking',
      lines: [
        'A seat at 0 HP or below is out at the end of the round.',
        'If a round would knock out everyone left, the seat with the least overkill survives on 1 HP. There is always exactly one winner.',
        `After ${rules.maxRounds} rounds the match ends anyway, and survivors rank by HP. Everyone else ranks by how long they lasted.`,
      ],
    },
  ];
}

function percent(bps: number): string {
  return `${Math.round((bps * 100) / BPS_DENOMINATOR)}%`;
}
