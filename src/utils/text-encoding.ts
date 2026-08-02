// Repairs text that Postgres would reject.
//
// The recurring case (issue #20): Windows tools like `wsl.exe` and PowerShell
// emit UTF-16LE. When Claude Code captures that output as UTF-8, every ASCII
// character arrives followed by a NUL byte, recorded faithfully in the
// transcript as the JSON escape sequence for U+0000:
//
//   "W.S.L. .v..." (dots are NULs)  ->  "WSL v..."
//
// For this corruption class, removing the NULs IS the decode: the readable
// characters are already present, in order, and the interleaved NULs are the
// only artifact. There is nothing further to recover — non-ASCII UTF-16 does
// not survive a UTF-8 read as char/NUL pairs at all; it arrives as NUL-free
// mojibake that no post-hoc transform can restore. So the honest repair is a
// strip, and it is also a safe one: no detection heuristic, no false
// positives, and byte-for-byte survival of every non-NUL, well-formed
// character. Nothing is truncated.
//
// Postgres stores no U+0000 anywhere — not in text ('invalid byte sequence
// for encoding "UTF8": 0x00'), not in jsonb values, not in jsonb keys — and
// it rejects lone surrogates the same way. One such character used to fail an
// entire session's sync.

// A surrogate half without its partner. Valid pairs (high followed by low) are
// real characters and must survive; anything else is not representable in
// UTF-8 and Postgres rejects it.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Drops NULs and lone surrogates — everything Postgres cannot store, and only
// that. Applied at the DB boundary so every write path — file sync, HTTP
// ingest, quarantine — is protected no matter which machine or code version
// produced the data.
export const normalizeText = (value: string): string =>
  value.replaceAll('\u0000', '').replace(LONE_SURROGATE, '');

// Walks a parsed JSON value and normalizes every string in it — including
// object keys, which jsonb rejects NULs in just like values. Dates and other
// non-plain objects pass through untouched.
//
// Keys that differ only by NULs collapse to the same normalized key. The rule
// is deterministic and the clean key always wins: an entry whose key came
// through normalization unchanged is authoritative; an entry whose key had to
// be repaired never overwrites a value that is already present.
export const normalizeDeep = <T>(value: T): T => {
  if (typeof value === 'string') return normalizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = normalizeText(k);
      if (key === k || !(key in out)) out[key] = normalizeDeep(v);
    }
    return out as T;
  }
  return value;
};
