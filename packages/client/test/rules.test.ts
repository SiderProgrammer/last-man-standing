import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '@lms/consensus';
import { rulesSheet } from '../src/ui/rules.js';

function text(rules = DEFAULT_RULES): string {
  return rulesSheet(rules)
    .flatMap((section) => [section.title, ...section.lines])
    .join('\n');
}

describe('rules sheet', () => {
  it('quotes the numbers the kernel runs under', () => {
    const sheet = text();
    expect(sheet).toContain(`${DEFAULT_RULES.startingHp} HP`);
    expect(sheet).toContain(`for ${DEFAULT_RULES.strikeDamage} damage`);
    expect(sheet).toContain('heals you 50% of it (12 HP)');
    expect(sheet).toContain(`send ${DEFAULT_RULES.guardReflectDamage} damage back`);
    expect(sheet).toContain('it hits for 59 instead of 25');
    expect(sheet).toContain('hit 25% harder (31 instead of 25)');
    expect(sheet).toContain(`After ${DEFAULT_RULES.maxRounds} rounds`);
  });

  it('names both cooldowns', () => {
    expect(text()).toContain('You cannot Guard two rounds in a row.');
    expect(text()).toContain('You cannot Charge two rounds in a row, or while a Charge is already loaded.');
  });

  it('starts the stall penalty after the grace of quiet rounds and grows it', () => {
    expect(text()).toContain('Once 2 rounds pass in a row');
    expect(text()).toContain('2 quiet rounds: 8 · 3 quiet rounds: 16 · 4 quiet rounds: 24');
  });

  it('follows a lobby that changes the rules', () => {
    const sheet = text({ ...DEFAULT_RULES, strikeDamage: 30, stallGraceRounds: 3, chargeExposureBps: 5000 });
    expect(sheet).toContain('for 30 damage');
    expect(sheet).toContain('Once 3 rounds pass in a row');
    expect(sheet).toContain('hit 50% harder (45 instead of 30)');
  });
});
