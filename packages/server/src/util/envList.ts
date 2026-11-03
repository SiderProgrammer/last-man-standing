import { errorMessage } from '@lms/api';

/**
 * Parses an environment variable holding a JSON array, softly: blank is an
 * empty list, invalid JSON is an empty list and a warning, and an entry
 * `parse` turns down (returns null for) is dropped with a warning.
 *
 * For the settings the server still runs without — avatar collections,
 * spokes, zap tokens, matchmaking tiers — where a typo must not stop matches
 * from being played or settled.
 *
 * @param name The variable, for the warnings.
 * @param tag The log prefix, for the warnings.
 */
export function parseJsonList<T>(raw: string, name: string, tag: string, parse: (item: unknown) => T | null): T[] {
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[${tag}] ${name} is not valid JSON:`, errorMessage(error));
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[${tag}] ${name} is not a JSON array`);
    return [];
  }
  return parsed.flatMap((item: unknown) => {
    const value = parse(item);
    if (value === null) console.warn(`[${tag}] ignoring an entry of ${name}:`, JSON.stringify(item));
    return value === null ? [] : [value];
  });
}

/** The fields of a JSON object, or null for anything else. */
export function fieldsOf(item: unknown): Record<string, unknown> | null {
  return typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
}
