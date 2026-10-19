import { describe, expect, it } from 'vitest';
import { Analyst, MemoryArchive, demoModel, playReferenceMatch } from '@lms/server';

describe('offline demo analyst', () => {
  it('runs the real pipeline, and the verifier drops its planted false claim', async () => {
    const match = playReferenceMatch({ label: 'demo', strategies: ['reader', 'aggressor', 'turtle', 'random', 'hider'] });
    const archive = new MemoryArchive();
    await archive.save(match);
    const analyst = new Analyst({
      archive,
      model: demoModel(archive, { chunkDelayMs: 0 }),
      modelId: 'demo',
      effort: 'low',
      maxTokens: 1_000,
    });

    const steps: string[] = [];
    let streamed = '';
    const { analysis } = await analyst.analyze({
      matchId: match.result.matchId,
      requester: match.seats?.[0]?.address as `0x${string}`,
      onStep: (step) => steps.push(step),
      onDelta: (text) => (streamed += text),
    });

    expect(steps).toHaveLength(2);
    expect(streamed).toBe(analysis.summary);
    expect(analysis.summary).toMatch(/not a real model/);
    expect(analysis.dropped).toBe(1);
    expect(analysis.keyMoments.length).toBeGreaterThanOrEqual(2);
    expect(analysis.decisiveRound).not.toBeNull();
  });
});
