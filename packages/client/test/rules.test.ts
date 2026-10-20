import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '@lms/protocol';
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
    expect(sheet).toContain(`for ${DEFAULT_RULES.attackDamage} damage`);
    expect(sheet).toContain(`take ${DEFAULT_RULES.riposteDamage} riposte`);
    expect(sheet).toContain('25% chance to miss');
    expect(sheet).toContain('only 75% of the storm');
    expect(sheet).toContain(`After ${DEFAULT_RULES.maxRounds} rounds`);
  });

  it('starts the storm after the grace rounds and ramps it', () => {
    expect(text()).toContain('From round 2 the storm');
    expect(text()).toContain('round 2: 6 · round 3: 12 · round 4: 18 · round 6: 30');
  });

  it('follows a lobby that changes the rules', () => {
    const sheet = text({ ...DEFAULT_RULES, attackDamage: 40, stormGraceRounds: 3, hideEvadeBps: 3333 });
    expect(sheet).toContain('for 40 damage');
    expect(sheet).toContain('From round 4 the storm');
    expect(sheet).toContain('33% chance to miss');
  });
});
