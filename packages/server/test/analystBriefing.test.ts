import { describe, expect, it } from 'vitest';
import { MemoryStyleBook, briefMatch, playReferenceMatch, tallyStyles } from '@lms/server';

const match = playReferenceMatch({ label: 'tools', strategies: ['reader', 'striker', 'guarder', 'charger'] });

describe('analyst briefing', () => {
  it('lays out every round in full', async () => {
    const briefing = await briefMatch(match, 0);
    expect(briefing).toContain('Every round in full:');
    for (const record of match.history) expect(briefing).toContain(`Round ${record.round}:`);
    // Seat 2 is the guarder.
    expect(briefing).toContain('#2 guard');
  });

  it('counts what each seat did over the match', async () => {
    const briefing = await briefMatch(match, 0);
    // The guarder guards whenever its cooldown allows and strikes otherwise; it never charges.
    expect(briefing).toMatch(/Seat #2 over the whole match: \d+ strikes, [1-9]\d* guards, 0 charges/);
    expect(briefing).toMatch(/Struck #0 \(the player this analysis is for\) \d+ times/);
    // The asking seat is not counted against itself.
    expect(briefing).not.toMatch(/Seat #0 over the whole match:[^\n]*the player this analysis is for/);
  });

  it('has no "you" for a spectator', async () => {
    expect(await briefMatch(match, null)).not.toContain('the player this analysis is for');
  });

  it('adds each seated wallet\'s earlier record when the server keeps them', async () => {
    expect(await briefMatch(match, 0)).not.toContain('Earlier matches:');

    const styles = new MemoryStyleBook();
    await styles.record(tallyStyles(match.result, match.history, match.seats.map((seat) => seat.address)));
    const briefing = await briefMatch(match, 0, styles);
    expect(briefing).toContain('Earlier matches:');
    expect(briefing).toMatch(/Seat #1 across 1 settled matches/);

    expect(await briefMatch(match, 0, new MemoryStyleBook())).toMatch(/Seat #1 has no settled matches on record/);
  });
});
