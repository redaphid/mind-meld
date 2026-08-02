/**
 * Normalizes text to clean UTF-8 at the earliest point after parsing.
 *
 * Two things reach us that PostgreSQL will not store:
 *
 *  - U+0000. `text` columns reject it outright ("invalid byte sequence for
 *    encoding UTF8: 0x00") and `jsonb` rejects the \\u0000 escape
 *    ("unsupported Unicode escape sequence"). The usual source is Windows
 *    tooling: wsl.exe and many PowerShell cmdlets emit UTF-16LE, so captured
 *    output arrives as "W\\u0000S\\u0000L\\u0000" once its bytes are read as
 *    UTF-8.
 *  - Lone surrogates. Half of a surrogate pair left behind by a truncated copy
 *    is valid in a JS string but not valid UTF-8, so jsonb rejects it too.
 *
 * One bad message used to fail the whole session insert, silently dropping the
 * session from the index on every sync.
 */

const NUL = String.fromCharCode(0);

/** Every other code unit is NUL — the signature of UTF-16LE read as UTF-8. */
function looksLikeUtf16Le(s: string): boolean {
  // Need a decent run to be confident; short strings with an incidental NUL
  // are better handled by the strip path below.
  if (s.length < 8) return false;

  let pairs = 0;
  let nulHigh = 0;
  for (let i = 0; i + 1 < s.length; i += 2) {
    pairs++;
    if (s[i + 1] === NUL) nulHigh++;
  }
  return pairs > 0 && nulHigh / pairs > 0.8;
}

/**
 * Recover UTF-16LE text. Each character's low byte survived the original UTF-8
 * read, so dropping the NUL high bytes restores the ASCII range exactly.
 * Non-ASCII code points were already lost to replacement characters when the
 * bytes were first decoded, so there is nothing to recover there.
 */
function decodeUtf16Le(s: string): string {
  return s.split(NUL).join('');
}

/** Strip lone surrogates, which are not representable in UTF-8. */
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function normalizeText(text: string): string {
  let out = text;

  if (out.includes(NUL)) {
    out = looksLikeUtf16Le(out) ? decodeUtf16Le(out) : out.split(NUL).join('');
  }

  // Cheap guard: the replace only runs when a surrogate is actually present.
  if (/[\uD800-\uDFFF]/.test(out)) {
    out = stripLoneSurrogates(out);
  }

  return out;
}

/**
 * Apply normalizeText to every string in a parsed JSON value, mutating objects
 * and arrays in place. Called immediately after JSON.parse so nothing
 * downstream — text columns, jsonb columns, embeddings, summaries — ever sees
 * the bad bytes.
 */
export function normalizeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return normalizeText(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = normalizeDeep(value[i]);
    }
    return value;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = normalizeDeep(obj[key]);
    }
    return value;
  }

  return value;
}
