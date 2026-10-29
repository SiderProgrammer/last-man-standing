import { describe, expect, it } from 'vitest';
import { tallyStyles } from '@lms/protocol';
import { MatchTools, MemoryStyleBook, TOOLS, playReferenceMatch } from '@lms/server';

const match = playReferenceMatch({ label: 'tools', strategies: ['reader', 'striker', 'guarder', 'charger'] });

describe('analyst tools', () => {
  it('are closed schemas in a fixed order', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(['get_match', 'get_player_history', 'get_reads', 'get_round']);
    for (const tool of TOOLS) {
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required).toEqual(Object.keys(tool.input_schema.properties ?? {}));
    }
  });

  it('take no match id or wallet, so they cannot reach outside this match', () => {
    const fields = TOOLS.flatMap((tool) => Object.keys(tool.input_schema.properties ?? {}));
    expect(new Set(fields)).toEqual(new Set(['seat', 'round']));
  });

  it('opens a round in full', async () => {
    const tools = new MatchTools(match, 0);
    const { content, isError } = await tools.run('get_round', { round: 1 });
    expect(isError).toBe(false);
    expect(content).toContain('Round 1:');
    // Seat 2 is the guarder.
    expect(content).toContain('#2 guard');
    expect(content).toMatch(/strikes: /);
  });

  it('explains a round that does not exist', async () => {
    const { content, isError } = await new MatchTools(match, 0).run('get_round', { round: 99 });
    expect(isError).toBe(true);
    expect(content).toMatch(`rounds 1 to ${match.history.length}`);
  });

  it('reads a seat the way the reads panel does', async () => {
    const tools = new MatchTools(match, 0);
    // The guarder guards whenever its cooldown allows and strikes otherwise; it never charges.
    const guarder = await tools.run('get_reads', { seat: 2 });
    expect(guarder.content).toMatch(/\d+ strikes, [1-9]\d* guards, 0 charges/);
    expect(guarder.content).toMatch(/Struck #0 \(the player this analysis is for\) \d+ times/);

    // The striker kept coming after #2: from there that reads as a grudge; to a spectator, as leader-hunting.
    expect((await new MatchTools(match, 2).run('get_reads', { seat: 1 })).content).toMatch(/Tell: has a grudge on you/);
    expect((await new MatchTools(match, null).run('get_reads', { seat: 1 })).content).toMatch(/Tell: hunts the leader\./);
  });

  it('reads the asking seat itself without a perspective', async () => {
    const own = await new MatchTools(match, 0).run('get_reads', { seat: 0 });
    expect(own.isError).toBe(false);
    expect(own.content).not.toContain('the player this analysis is for');
  });

  it('looks up a seated wallet in the style book, and only a seated one', async () => {
    const styles = new MemoryStyleBook();
    await styles.record(tallyStyles(match.result, match.history, match.seats.map((seat) => seat.address)));
    const tools = new MatchTools(match, 0, styles);

    const record = await tools.run('get_player_history', { seat: 1 });
    expect(record.content).toMatch(/across 1 settled matches/);
    expect((await tools.run('get_player_history', { seat: 9 })).isError).toBe(true);
    expect((await new MatchTools(match, 0).run('get_player_history', { seat: 1 })).content).toMatch(/No match records/);
  });

  it('reports a stranger with no record', async () => {
    const tools = new MatchTools(match, 0, new MemoryStyleBook());
    expect((await tools.run('get_player_history', { seat: 1 })).content).toMatch(/no settled matches/);
  });

  it('rejects input that does not match the schema rather than guessing', async () => {
    const tools = new MatchTools(match, 0);
    for (const input of [{ round: '1' }, { round: 1.5 }, {}, { round: 1, matchId: '0x00' }, null]) {
      const result = await tools.run('get_round', input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(result.content).toMatch(/invalid input/);
    }
    expect((await tools.run('get_wallet', { address: '0x00' })).content).toMatch(/no tool named/);
  });

  it('serves the overview again on request', async () => {
    const { content } = await new MatchTools(match, 1).run('get_match', {});
    expect(content).toContain('#1 ');
    expect(content).toContain('(you)');
    expect(content).toContain(`Round ${match.history.length}:`);
  });
});
