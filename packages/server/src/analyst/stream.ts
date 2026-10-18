/**
 * Pulls one top-level string field out of a JSON document while it is still
 * arriving, decoded, a fragment at a time.
 *
 * The model answers in structured JSON, which is what makes the answer
 * checkable — but a player watching raw JSON stream in sees braces and
 * escapes. This lets the server forward only the narrative as it is written,
 * and still parse the complete document strictly once it has all arrived.
 * Nothing it emits is authoritative; the final parse is.
 *
 * Incremental: each character is examined once, so a long answer costs
 * linear time however finely it is chunked. It assumes the document is a JSON
 * object and only tracks enough of the grammar to find the field.
 */
export class JsonFieldStream {
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Characters of the key being read, when the current string is a top-level key. */
  private key: string | null = null;
  /** The last top-level key whose value has not started yet. */
  private pendingKey: string | null = null;
  /** Last character outside a string that was not whitespace. */
  private last = '';
  private capturing = false;
  private done = false;
  /** A `\uXXXX` escape whose hex digits have not all arrived. */
  private unicode: string | null = null;

  constructor(private readonly field: string) {}

  /** Feeds the next chunk; returns the newly decoded part of the field, possibly empty. */
  push(chunk: string): string {
    let out = '';
    for (const char of chunk) {
      if (this.done) break;
      if (this.capturing) out += this.capture(char);
      else this.scan(char);
    }
    return out;
  }

  private capture(char: string): string {
    if (this.unicode !== null) {
      this.unicode += char;
      if (this.unicode.length < 4) return '';
      const code = Number.parseInt(this.unicode, 16);
      this.unicode = null;
      return Number.isNaN(code) ? '' : String.fromCharCode(code);
    }
    if (this.escaped) {
      this.escaped = false;
      if (char === 'u') {
        this.unicode = '';
        return '';
      }
      return ESCAPES[char] ?? char;
    }
    if (char === '\\') {
      this.escaped = true;
      return '';
    }
    if (char === '"') {
      this.capturing = false;
      this.done = true;
      return '';
    }
    return char;
  }

  private scan(char: string): void {
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        if (this.key !== null) this.key += char;
      } else if (char === '\\') {
        this.escaped = true;
      } else if (char === '"') {
        this.inString = false;
        if (this.key !== null) {
          this.pendingKey = this.key;
          this.key = null;
        }
        this.last = '"';
      } else if (this.key !== null) {
        this.key += char;
      }
      return;
    }

    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') return;

    if (char === '"') {
      // A value right after `:` at the top level, for the key we want.
      if (this.depth === 1 && this.last === ':' && this.pendingKey === this.field) {
        this.capturing = true;
        this.pendingKey = null;
        return;
      }
      this.inString = true;
      // A string right after `{` or `,` at the top level is a key.
      this.key = this.depth === 1 && (this.last === '{' || this.last === ',') ? '' : null;
      return;
    }

    // Any other token straight after a colon means that value is not a string.
    if (this.last === ':') this.pendingKey = null;
    if (char === '{' || char === '[') this.depth += 1;
    else if (char === '}' || char === ']') this.depth -= 1;
    this.last = char;
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '"': '"',
  '\\': '\\',
  '/': '/',
};
