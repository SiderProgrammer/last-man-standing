import { describe, expect, it } from 'vitest';
import { JsonFieldStream } from '@lms/server';

/** Feeds a document in chunks of the given size and joins what comes out. */
function extract(document: string, field: string, chunk: number): string {
  const stream = new JsonFieldStream(field);
  let out = '';
  for (let i = 0; i < document.length; i += chunk) out += stream.push(document.slice(i, i + chunk));
  return out;
}

describe('JsonFieldStream', () => {
  const value = 'Seat #2 "hunted" the leader\n\tthen hid — and won. Path: a/b \\ c 🎯';
  const document = JSON.stringify({ summary: value, decisiveRound: 4, keyMoments: [], advice: ['x'] });

  it('decodes the field however the document is chunked', () => {
    for (const chunk of [1, 2, 3, 7, 64, document.length]) {
      expect(extract(document, 'summary', chunk), `chunk ${chunk}`).toBe(value);
    }
  });

  it('decodes \\u escapes split across chunks, surrogate pairs included', () => {
    const escaped = '{"summary":"caf\\u00e9 \\ud83c\\udfaf"}';
    for (const chunk of [1, 2, 5]) expect(extract(escaped, 'summary', chunk)).toBe('café 🎯');
  });

  it('finds the field wherever it sits among the keys', () => {
    const later = JSON.stringify({ decisiveRound: null, keyMoments: [{ claim: 'summary' }], summary: value });
    expect(extract(later, 'summary', 3)).toBe(value);
  });

  it('ignores the same name nested deeper or used as a value', () => {
    const nested = JSON.stringify({ a: { summary: 'nested' }, b: 'summary', summary: 'top' });
    expect(extract(nested, 'summary', 1)).toBe('top');
  });

  it('emits nothing when the field is not a string', () => {
    expect(extract('{"summary": 5, "other": "text"}', 'summary', 1)).toBe('');
    expect(extract('{"summary": ["a"], "other": "text"}', 'summary', 1)).toBe('');
  });

  it('stops at the end of the field', () => {
    const stream = new JsonFieldStream('summary');
    expect(stream.push('{"summary":"done"')).toBe('done');
    expect(stream.push(',"advice":["more text"]}')).toBe('');
  });

  it('tolerates whitespace between tokens', () => {
    expect(extract('{ \n "summary" \t :  "spaced" }', 'summary', 2)).toBe('spaced');
  });
});
