// Repairs text that Postgres would reject — and, where possible, recovers what
// it was supposed to say.
//
// The recurring case (issue #20): Windows tools like `wsl.exe` and PowerShell
// emit UTF-16LE. When Claude Code captures that output as UTF-8, every ASCII
// character arrives followed by a NUL byte, recorded faithfully in the
// transcript as the JSON escape \u0000:
//
//   "W.S.L. .v..." (dots are NULs)  ->  "WSL v..."
//
// Postgres stores no U+0000 anywhere — not in text ('invalid byte sequence for
// encoding "UTF8": 0x00'), not in jsonb values, not in jsonb keys — and it
// rejects lone surrogates the same way. One such character used to fail an
// entire session's sync.
//
// Merely stripping NULs keeps the insert alive but stores the mangled text.
// Decoding the alternating run first recovers the readable text, so what is
// stored (and embedded, and searched) is what the tool actually printed.
// Nothing else is altered and nothing is truncated: every non-NUL,
// well-formed character survives byte-for-byte.

// A run of UTF-16LE-as-UTF-8: two or more characters each followed by NUL
// (little-endian, the Windows default), optionally ending on a bare character
// whose trailing NUL was cut off. The BE alternation (NUL first) is accepted
// too — same mistake, opposite byte order.
const UTF16_RUN = /(?:[^\u0000]\u0000){2,}[^\u0000]?|(?:\u0000[^\u0000]){2,}/g;

// A surrogate half without its partner. Valid pairs (high followed by low) are
// real characters and must survive; anything else is not representable in
// UTF-8 and Postgres rejects it.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Decodes alternating char/NUL runs back to the text they encode. Runs shorter
// than two pairs are left for the NUL strip below — with one pair there is no
// evidence of UTF-16, and the result is identical either way.
export const decodeUtf16Runs = (value: string): string =>
  value.includes('\u0000')
    ? value.replace(UTF16_RUN, (run) => run.replaceAll('\u0000', ''))
    : value;

// The full repair: decode UTF-16 runs, then drop whatever stray NULs and lone
// surrogates remain. Applied at the DB boundary so every write path — file
// sync, HTTP ingest, quarantine replay — is protected no matter which machine
// or code version produced the data.
export const normalizeText = (value: string): string =>
  decodeUtf16Runs(value).replaceAll('\u0000', '').replace(LONE_SURROGATE, '');

// Walks a parsed JSON value and normalizes every string in it — including
// object keys, which jsonb rejects NULs in just like values. Dates and other
// non-plain objects pass through untouched.
export const normalizeDeep = <T>(value: T): T => {
  if (typeof value === 'string') return normalizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => normalizeDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [normalizeText(k), normalizeDeep(v)])
    ) as T;
  }
  return value;
};
