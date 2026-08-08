// Personal-data detection, shared by the whole-repo test guard
// (src/quality/no-personal-data.test.ts) and the pre-commit hook
// (.githooks/pre-commit). ONE definition, two callers — see CLAUDE.md,
// "Shared definitions over restated ones".
//
// Plain ESM JavaScript on purpose. The pre-commit hook must run with nothing
// but `node` on PATH: a guard that needs `pnpm install` first is a guard that
// blocks every commit in a fresh clone or a new worktree, and a guard that
// blocks everything gets `--no-verify`'d within a day.
//
// THREE TIERS, and the difference between them is the whole point.
//
//   1. STRUCTURAL (`scanStructural`) — path/machine shapes whose user segment
//      is a real name. Needs no denylist, so it catches values nobody has
//      thought of yet.
//
//   2. TERM (`scanTerms`) — exact tokens listed as SHA-256 hashes in
//      quality/personal-terms.json, so this file does not reproduce the very
//      values it exists to keep out of a PUBLIC repo.
//
//   3. QUOTED PERSONAL CONTENT (`scanIdentifiers`) — NEW, and the reason the
//      hook exists. Tiers 1 and 2 were run against the AGENTS.md that nearly
//      shipped on 2026-08-07 and returned ZERO findings, while that file held
//      real session ids, real message ids and `Uber Eats` queries lifted from
//      `dataClass: personal` / `source: android` records. Tiers 1+2 answer
//      "did a home path or a known banned word leak". They have no concept of
//      *real content quoted out of private records*, which is the class that
//      actually leaked. Tier 3 is that concept.
//
// Findings report file, line, rule, and a MASKED excerpt. Never the raw value:
// this repo's CI logs are public, and a local hook's output is itself indexed
// into mindmeld, so echoing the leak is how you leak it twice.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Segments that are obviously stand-ins rather than a real person or machine. */
export const PLACEHOLDERS = new Set([
  'you', 'your-username', 'your-user', 'user', 'username', 'users', 'me', 'u',
  'someone', 'somebody', 'alice', 'bob', 'example', 'test', 'dev', 'demo',
  'root', 'node', 'runner', 'ubuntu', 'distro', 'your-distro', 'name',
  'localhost',
]);

/**
 * Machine names that describe a platform or a role rather than a device. These
 * are only accepted where a machine name is expected — keeping them out of
 * PLACEHOLDERS means `/home/windows` is still a finding.
 */
export const GENERIC_MACHINE_NAMES = new Set([
  'wsl', 'windows', 'linux', 'macos', 'mac', 'darwin', 'docker', 'container',
  'ci', 'local', 'localhost', 'host', 'hostname', 'server', 'machine',
  'default', 'unknown', 'none',
]);

/**
 * Trailing role words in an mDNS label: `ollama-host.local` names the job a
 * box does, not the box. Device-type words (`macbook`, `laptop`) are NOT here
 * — those pair with a personal name far more often than not.
 */
const HOST_ROLE_WORDS = new Set(['host', 'hostname', 'server']);

/** `pnpm@latest`, `image@stable` — a dist-tag after `@` is a version, not a box. */
const DIST_TAGS = new Set([
  'latest', 'stable', 'next', 'beta', 'alpha', 'canary', 'edge', 'nightly',
  'main', 'master', 'head',
]);

/**
 * Paths that are noise to scan: vendored code, lockfiles, binaries, and the
 * guard's own files — this module names `Uber` in plaintext, so it would
 * otherwise flag itself.
 */
export const SKIP = [
  'pnpm-lock.yaml',
  'public/vendor/',
  'quality/personal-terms.json',
  'src/quality/no-personal-data.test.ts',
  'src/quality/personal-data.mjs',
  '.githooks/',
];

/** Generated dependency graphs: thousands of lines nobody wrote, at any depth. */
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/;

export const isSkipListed = (file) =>
  LOCKFILE.test(file) || SKIP.some((skip) => file === skip || file.startsWith(skip));

/**
 * A placeholder may be bare (`you`), bracketed (`<you>`), or a shell variable
 * (`$USER`, `${USER}`, `%USERNAME%`). Normalize before comparing.
 */
export const isPlaceholder = (segment) => {
  const bare = segment
    .toLowerCase()
    .replace(/^[<{[(]+|[>}\])]+$/g, '')
    .replace(/^\$\{?|\}?$/g, '')
    .replace(/^%|%$/g, '');
  // `C:\Users\...` in prose elides the name rather than revealing one, and
  // `/home/%` (SQL LIKE) or `/home/*` (glob) match every user, naming none.
  if (/^[.*%]*$/.test(bare)) return true;
  return PLACEHOLDERS.has(bare);
};

/**
 * @typedef {{ file: string, line: number, check: string, excerpt: string }} Finding
 */

/**
 * Show enough to find the value on the line without reprinting it. Two leading
 * characters survive; everything else becomes a bullet.
 */
export const mask = (value) => {
  const text = String(value);
  if (text.length <= 2) return '•'.repeat(text.length);
  return text.slice(0, 2) + '•'.repeat(Math.min(text.length - 2, 12));
};

// ---------------------------------------------------------------------------
// Tier 1: structural path and machine shapes
// ---------------------------------------------------------------------------

/** Home directories on every platform, plus the WSL view of a Windows home. */
const HOME_PATH =
  /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/mnt\/[a-z]\/Users\/)([A-Za-z0-9._$<>{}%()[\]-]+)/g;

/** \\wsl$\<distro>\... and \\wsl.localhost\<distro>\... — the distro names a machine. */
const WSL_UNC = /\\\\wsl(?:\$|\.localhost)\\+([^\\\s"'`]+)/gi;

/**
 * `~alice/...` — the same leak as /home/alice, written shorter. `~/` names
 * nobody, and the segment must start like a username so approximations
 * (`~265KB/day`) are not usernames.
 *
 * A `${...}` interpolation is matched as ONE bounded unit so a segment cannot
 * run past its closing brace. Without that bound, `~${fmtDuration(x)}</span>`
 * — the idiomatic way to render "retries in ~5m" — reads as a home path.
 * This narrows where a segment ENDS, never which names count: `~${USER}/`
 * still passes and `~${REALNAME}/` is still a finding.
 *
 * The `(?!\$\{)` guard on the second branch is load-bearing: alternation
 * backtracks, so without it the greedy branch re-eats the interpolation the
 * first branch just declined and the false positive returns.
 */
const TILDE_HOME =
  /(?<![\w~/\\.-])~(\$\{[^}]*\}|(?!\$\{)[A-Za-z_$<{%([][A-Za-z0-9._$<>{}%()[\]-]*)\//g;

/**
 * Claude Code stores a project under a directory name that is its path with
 * every separator replaced by a hyphen (`decodeProjectPath`,
 * src/parsers/claude-messages.ts). That is a home path the HOME_PATH regex
 * cannot see, and it is the natural shape for a fixture copied from a real
 * transcript. Decode, then reuse the check.
 */
const ENCODED_HOME = /-(?:Users|home)-[A-Za-z0-9._$<>{}%()[\]-]+/gi;
const decodeEncodedPath = (encoded) => encoded.replace(/-/g, '/');

/**
 * `<label>.local` is mDNS: the label is a device name. Excluded by the
 * boundaries: `wsl.localhost` (longer word), `docker-compose.local.yml` and
 * `.env.local` (a file-name segment, not a hostname).
 */
const MDNS = /(?<![\w.-])([A-Za-z0-9][A-Za-z0-9-]*)\.local(?![\w.-])/g;

/**
 * `user@host` with a bare host. A version (`pnpm@10.11.0`), an action ref
 * (`actions/checkout@v4`) and an email (`x@example.com`) are excluded by
 * requiring a letter-led host with no dot other than a trailing `.local`.
 */
const USER_AT_HOST =
  /(?<![\w@/.-])([A-Za-z][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9-]*(?:\.local)?)(?![\w.@-])/g;

/**
 * A machine-name assignment holding a literal. Device names were the largest
 * leak category in the scrub; hashing the known ones defends the past, this
 * defends the shape. A value deferred to the environment (`${VAR:?...}`) names
 * nobody — only a hardcoded default is a finding.
 */
const MACHINE_ASSIGNMENT =
  /\b(?:MACHINE|DEVICE|COMPUTER|HOST)_?NAME[A-Z0-9_]*\s*[:=]\s*["']?([^\s"',]+)/g;

/** `${VAR:-fallback}` leaks the fallback; `${VAR:?msg}` and `$VAR` leak nothing. */
const literalOf = (value) => {
  if (!value.includes('$')) return value;
  const withDefault = /\$\{[A-Za-z0-9_]+:-([^}]*)\}/.exec(value);
  return withDefault ? withDefault[1] : null;
};

/**
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
export const scanStructural = (file, content) => {
  /** @type {Finding[]} */
  const findings = [];
  const add = (line, check, excerpt) =>
    findings.push({ file, line, check, excerpt: mask(excerpt) });

  content.split('\n').forEach((text, index) => {
    const line = index + 1;

    for (const [pattern, check] of [
      [HOME_PATH, 'home-directory path with a real user segment'],
      [WSL_UNC, 'WSL UNC path naming a real distro'],
      [TILDE_HOME, 'tilde home path naming a real user'],
    ]) {
      for (const match of text.matchAll(pattern)) {
        if (!isPlaceholder(match[1])) add(line, check, match[0]);
      }
    }

    for (const match of text.matchAll(ENCODED_HOME)) {
      const decoded = decodeEncodedPath(match[0]);
      for (const inner of decoded.matchAll(HOME_PATH)) {
        if (!isPlaceholder(inner[1])) {
          add(line, 'encoded project-directory path with a real user segment', match[0]);
        }
      }
    }

    for (const match of text.matchAll(MDNS)) {
      const label = match[1].toLowerCase();
      const lastWord = label.split('-').at(-1) ?? label;
      if (isPlaceholder(label) || GENERIC_MACHINE_NAMES.has(label)) continue;
      if (HOST_ROLE_WORDS.has(lastWord)) continue;
      add(line, 'mDNS name identifying a device', match[0]);
    }

    for (const match of text.matchAll(USER_AT_HOST)) {
      const host = match[2].toLowerCase().replace(/\.local$/, '');
      // A dist-tag is a version; parts under three characters are stand-ins
      // (`t@t` in a fixture), not a person on a machine.
      if (DIST_TAGS.has(host) || host.length < 3 || match[1].length < 3) continue;
      const userNamesNobody = isPlaceholder(match[1]);
      const hostNamesNobody = isPlaceholder(host) || GENERIC_MACHINE_NAMES.has(host);
      if (userNamesNobody && hostNamesNobody) continue;
      add(line, 'user@host naming a person and a machine', match[0]);
    }

    for (const match of text.matchAll(MACHINE_ASSIGNMENT)) {
      const literal = literalOf(match[1]);
      if (literal === null) continue;
      const name = literal.replace(/["'}]+$/, '').toLowerCase();
      if (!name || isPlaceholder(name) || GENERIC_MACHINE_NAMES.has(name)) continue;
      add(line, 'machine-name assignment holding a literal device name', name);
    }
  });
  return findings;
};

// ---------------------------------------------------------------------------
// Tier 2: banned terms, by hash
// ---------------------------------------------------------------------------

// Tokens repeat heavily across a repo; hashing each one once keeps a
// whole-repo scan fast enough that nobody is tempted to skip it.
const hashCache = new Map();

/** @param {string} token */
export const hash = (token) => {
  const cached = hashCache.get(token);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256').update(token).digest('hex');
  hashCache.set(token, digest);
  return digest;
};

/** @param {string} repoRoot */
export const loadTermHashes = (repoRoot) => {
  const raw = readFileSync(`${repoRoot}/quality/personal-terms.json`, 'utf8');
  return new Set(JSON.parse(raw).terms);
};

/**
 * @param {string} file
 * @param {string} content
 * @param {Set<string>} banned
 * @returns {Finding[]}
 */
export const scanTerms = (file, content, banned) => {
  /** @type {Finding[]} */
  const findings = [];
  content.split('\n').forEach((text, index) => {
    for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
      if (!banned.has(hash(token))) continue;
      findings.push({
        file,
        line: index + 1,
        check: 'banned personal term',
        excerpt: mask(token),
      });
    }
  });
  return findings;
};

// ---------------------------------------------------------------------------
// Tier 3: content quoted out of private records
//
// Everything below exists because tiers 1 and 2 passed cleanly on a document
// full of the user's phone data. These rules do not ask "is this a path" —
// they ask "is this a value that could only have come from his records".
// ---------------------------------------------------------------------------

/**
 * A live database id presented as an example. Real mindmeld session and
 * message ids are bare integers, so a doc that writes `Session: 104057` has
 * copied a row out of the index; the placeholder form `<SESSION_ID>` says the
 * same thing and names nothing.
 *
 * Four digits is the floor deliberately: `session 3`, `chunk 8 of 12` and
 * `limit=100` are counts and cardinals that appear all over honest prose, and
 * a guard that fires on them is a guard that gets disabled. Ids in this index
 * are five and six digits, so the floor costs nothing real.
 *
 * The keyword must be followed by a separator (`:`/`=`/`#`/`_id`) or a single
 * space. That is what keeps `"message": "Bad Request"` and `"messageCount":
 * 185` out: a quoted JSON key puts a `"` between the word and the colon.
 */
const LIVE_ID =
  /\b(session|message|msg|conversation|chunk|project|thread)s?[ _-]?(?:id)?\s*(?:[:=#]|\bis\b)\s*["'`]?(\d{4,})\b/gi;

/**
 * Prose, where a bare id can only be an example copied out of the live index —
 * there is no test fixture to justify it and `<SESSION_ID>` says the same
 * thing. AGENTS.md, the file that nearly shipped, is this shape.
 */
const DOC_FILE = /(^|\/)(docs?|AGENTS|README|CLAUDE)([./]|$)|\.(md|mdx|txt|rst|adoc)$/i;

/**
 * Digits needed before a number counts as a live id, by file kind.
 *
 * Code gets a higher floor on purpose. Test fixtures legitimately invent ids,
 * and this repo's existing ones are four digits (`sessionId: 4268`); firing on
 * those would make the hook something every agent learns to `--no-verify`
 * past. Real ids in the live index are six (`104057`), so a six-digit literal
 * in code is a copied row rather than an invented one. Docs get no such
 * excuse: the placeholder form costs nothing there.
 */
const idFloor = (file) => (DOC_FILE.test(file) ? 4 : 6);

/** `Session: <SESSION_ID>` — the documented way to write the same sentence. */
const ID_PLACEHOLDER = /<[A-Z_]*ID>|\$\{?[A-Z_]*ID\}?|:id\b|\{id\}/;

/**
 * Consumer apps and brands. These reach this repo one way only: as the title
 * of a phone notification or the subject of an SMS in a `dataClass: personal`
 * record, then pasted into a doc as an "example query". `Uber Eats` is on this
 * list because it is literally what nearly shipped.
 *
 * The list is deliberately confined to names with no engineering meaning here.
 * Amazon (AWS), Slack, Discord, Signal, GitHub and friends are NOT listed:
 * they appear in honest technical prose, and a rule that fires on them is a
 * rule that gets bypassed. That is a known, accepted hole — see the module
 * header. Add a name here the moment it shows up in his notification feed.
 */
const VENDOR_NAMES = [
  // Food, delivery, rideshare — where this leak came from.
  'uber eats', 'uber', 'ubereats', 'ubercab', 'lyft', 'doordash', 'grubhub', 'postmates',
  'instacart', 'caviar', 'chipotle', 'starbucks', 'dominos', 'mcdonalds',
  'wendys', 'taco bell', 'dunkin', 'walgreens', 'costco', 'safeway', 'kroger',
  'trader joes', 'wholefoods',
  // Money.
  'venmo', 'zelle', 'cashapp', 'paypal', 'klarna', 'robinhood', 'coinbase',
  'creditkarma', 'experian', 'equifax',
  // Dating — the single most sensitive category on a phone.
  'tinder', 'bumble', 'grindr', 'okcupid',
  // Travel, tickets, home, shopping.
  'ticketmaster', 'stubhub', 'seatgeek', 'airbnb', 'vrbo', 'zillow', 'redfin',
  'opentable', 'wayfair', 'etsy', 'ebay',
  // Health and habit tracking.
  'peloton', 'strava', 'fitbit', 'duolingo', 'noom',
  // Media and social.
  'netflix', 'hulu', 'roku', 'spotify', 'pandora', 'audible', 'crunchyroll',
  'tiktok', 'snapchat', 'instagram', 'whatsapp', 'telegram',
  // Devices and delivery notifications.
  'wyze', 'simplisafe', 'lastpass', 'usps', 'fedex',
  // Vehicles: `q=Kia` is already committed in docs/openapi.yaml, lifted from
  // his records the same way `Uber Eats` was.
  'kia', 'subaru', 'hyundai', 'chevrolet', 'volkswagen',
];
// Deliberately NOT listed, because they are ordinary words or ordinary
// engineering vocabulary here and a rule that fires on them is a rule that
// gets bypassed: ring (ring buffer), nest/nested, calm, chime, hinge, affirm,
// seamless, headspace, amazon (AWS), slack, discord, signal, github, apple.

// Longest first: JS alternation is leftmost-FIRST, not leftmost-longest, so
// without the sort `Uber Eats` reports as `Uber` and the finding says less
// than it knows.
const VENDOR = new RegExp(
  `(?<![A-Za-z0-9])(${[...VENDOR_NAMES]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/ /g, '[ .-]?'))
    .join('|')})(?![A-Za-z0-9])`,
  'gi',
);

/**
 * An Android notification's external id, `notif:<package>:<title>` — the
 * literal shape mindmeld stores phone notifications under. The documented
 * placeholder has no dots in the package segment, so `notif:<package>:<title>`
 * passes and `notif:com.ubercab.eats:Your order is here` does not.
 */
const NOTIF_EXTERNAL_ID = /\bnotif:[a-z0-9_]+(?:\.[a-z0-9_]+)+:/gi;

/**
 * A US phone number. Dots are NOT accepted as separators — `192.168.1.1` and
 * version strings are far more common in this repo than `555.123.4567`.
 */
const PHONE =
  /(?<![\d\w-])(?:\+?1[ -]?)?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}(?![\d-])/g;

/** A street address: a house number, a name, and a street-type word. */
const STREET_ADDRESS =
  /\b\d{1,5}\s+(?:[A-Z][A-Za-z]*\.?\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Terrace|Ter|Place|Pl|Parkway|Pkwy|Highway|Hwy|Way)\b\.?/g;

/**
 * A named human in a contact-shaped field. Names cannot be enumerated, so this
 * catches only the shape a transcribed contact arrives in. Generic `from:` and
 * `to:` are excluded — they are git, YAML and HTTP vocabulary here.
 */
const CONTACT_FIELD =
  /\b(?:contact|caller|calledBy|sender|recipient|texted|messaged|spokeWith|attendee|guest)s?\s*[:=]\s*["'`]?([A-Z][a-z]+ [A-Z][a-z]+)/g;

/**
 * A personal email address. The structural `user@host` rule deliberately
 * ignores anything with a dotted host, so real addresses walked straight
 * through it. Domains that name nobody are allowed.
 */
// The TLD must be alphabetic. Without that, `pnpm@10.11.0` and every
// `pkg@4.120.0(dep@4.20260702.1)` line in a lockfile reads as an address —
// 195 findings in this repo, all of them versions.
const EMAIL = /(?<![\w.+-])([A-Za-z0-9_.+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w.-])/g;
const EMAIL_ALLOWED_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'anthropic.com',
  'users.noreply.github.com', 'github.com', 'localhost', 'test.com',
  'domain.com', 'email.com', 'mail.com', 'company.com',
]);

/**
 * Content quoted out of a private record. Runs over ONE line at a time, so it
 * can be applied to a diff hunk as easily as to a whole file.
 *
 * @param {string} file
 * @param {string} content
 * @returns {Finding[]}
 */
export const scanIdentifiers = (file, content) => {
  /** @type {Finding[]} */
  const findings = [];
  const add = (line, check, excerpt) =>
    findings.push({ file, line, check, excerpt: mask(excerpt) });
  const floor = idFloor(file);

  content.split('\n').forEach((text, index) => {
    const line = index + 1;

    for (const match of text.matchAll(LIVE_ID)) {
      if (match[2].length < floor) continue;
      // A line that also carries the placeholder form is documenting the
      // shape, not quoting a row: `Session: <SESSION_ID> (e.g. 104057)` is
      // still a finding, but `id=1234 becomes <SESSION_ID>` is not.
      if (ID_PLACEHOLDER.test(text.slice(0, match.index))) continue;
      add(line, `live ${match[1].toLowerCase()} id — use a <..._ID> placeholder`, match[2]);
    }

    for (const match of text.matchAll(VENDOR)) {
      add(line, 'consumer app/vendor name from the personal notification feed', match[0]);
    }

    for (const match of text.matchAll(NOTIF_EXTERNAL_ID)) {
      add(line, 'real Android notification external id', match[0]);
    }

    for (const match of text.matchAll(PHONE)) {
      add(line, 'phone number', match[0]);
    }

    for (const match of text.matchAll(STREET_ADDRESS)) {
      add(line, 'street address', match[0]);
    }

    for (const match of text.matchAll(CONTACT_FIELD)) {
      add(line, 'personal name in a contact field', match[1]);
    }

    for (const match of text.matchAll(EMAIL)) {
      if (EMAIL_ALLOWED_DOMAINS.has(match[2].toLowerCase())) continue;
      if (isPlaceholder(match[1])) continue;
      add(line, 'email address', match[0]);
    }
  });
  return findings;
};

// ---------------------------------------------------------------------------

/**
 * Decode a file to text, or null if it is genuinely binary.
 *
 * "Contains a NUL byte" is NOT the same as binary: UTF-16 text is half NUL by
 * construction, and this repo handles UTF-16LE content. Treating it as binary
 * would silently exempt a real text file from the guard, so BOM-marked UTF-16
 * is decoded rather than skipped.
 *
 * @param {Buffer} buffer
 * @returns {string | null}
 */
export const decodeText = (buffer) => {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.from(buffer.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
  }
  // No BOM: a run of NULs at odd and even offsets alike is real binary.
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
};
