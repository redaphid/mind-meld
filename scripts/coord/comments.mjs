#!/usr/bin/env node
// Who said what, and is anyone waiting on us?
//
// This is the one piece of the coordinator toolchain whose failure is silent.
// It used to be two different jq one-liners embedded in two shell scripts, and
// they disagreed:
//
//   lib.sh   treated ANY comment starting with 🤖 as "the coordinator replied",
//            so an implementation agent's `🤖 **Agent (…):**` status post —
//            posted under the operator's own account — marked every operator
//            directive before it as answered. Reproduced on live data: three
//            operator asks vanished from the inbox without ever being read.
//   inbox.sh used `^\s*(🤖|🔎|⏱️)`, which missed the heartbeat comment (it
//            starts with an HTML comment), so the coordinator's own channel
//            permanently showed as "waiting on a reply".
//
// One classifier now, in node — the coordinator host runs git-bash where jq is
// absent but node is a hard dependency of the project anyway — and it is unit
// tested (src/__tests__/coord-comments.test.ts).
//
// Bias, stated once and applied everywhere: a false alarm is cheap, a dropped
// operator message is not. When a comment is ambiguous it counts as an
// unanswered operator message, and only the CURRENT generation's coordinator
// marker is allowed to mark anything answered.
//
//   comments.mjs classify   --generation vN                < body
//   comments.mjs unanswered --owner LOGIN --generation vN   < comments-json
//   comments.mjs heartbeat                                  < comments-json
//   comments.mjs inbox      --generation vN [--all]         < graphql-json

const HEARTBEAT_MARKER = '<!-- coord-heartbeat -->';

// Markers every machine speaker in this repo uses: agents (🤖), reviewers (🔎),
// the deadman (⏱️), read receipts (👀). The variation selector after ⏱ is
// optional because it is invisible and routinely dropped by hand-typed posts.
const MACHINE_MARKER = /^(?:🤖|🔎|⏱️?|👀)/u;

/** The coordinator's own marker, by generation. Mirrors coord_marker() in lib.sh. */
export function coordMarker(generation) {
  return `🤖 **Coordinator ${generation}:**`;
}

/**
 * 'heartbeat'   — the pinned liveness comment. Neither a reply nor an ask.
 * 'coordinator' — THIS generation's coordinator speaking. Only this answers.
 * 'machine'     — an agent, reviewer, bot or older generation. Ignored.
 * 'operator'    — everything else. Assumed to be a human asking for something.
 */
export function classify(body, generation) {
  const text = String(body ?? '');
  if (text.includes(HEARTBEAT_MARKER)) return 'heartbeat';

  const trimmed = text.replace(/^\s+/u, '');
  // Checked before the generic machine marker: `🤖 **Coordinator v2:**` also
  // matches MACHINE_MARKER, and only the specific form may advance the cutoff.
  if (generation && trimmed.startsWith(coordMarker(generation))) return 'coordinator';
  if (MACHINE_MARKER.test(trimmed)) return 'machine';
  // An HTML-comment-led body is tooling output, not a person typing.
  if (trimmed.startsWith('<!--')) return 'machine';
  return 'operator';
}

/**
 * `gh api --paginate --slurp` returns an array of pages; a single request
 * returns a flat array. Accept either, so callers never have to care.
 */
export function flattenPages(parsed) {
  if (!Array.isArray(parsed)) return [];
  return Array.isArray(parsed[0]) ? parsed.flat() : parsed;
}

/**
 * Operator comments that arrived after the coordinator's last reply.
 *
 * The cutoff is keyed on comment `id`, not `created_at`: ids increase
 * monotonically, whereas a comment edited into coordinator form keeps its
 * original `created_at` and would rewind the cutoff past later asks.
 */
export function unanswered(comments, { owner, generation }) {
  const mine = comments.filter(
    (c) => c?.user?.login === owner && c.author_association === 'OWNER'
  );
  const cutoff = mine
    .filter((c) => classify(c.body, generation) === 'coordinator')
    .reduce((max, c) => (Number(c.id) > max ? Number(c.id) : max), -Infinity);

  return mine.filter(
    (c) => classify(c.body, generation) === 'operator' && Number(c.id) > cutoff
  );
}

/** The pinned heartbeat comment on a thread, or null. */
export function latestHeartbeat(comments) {
  const hits = comments.filter((c) => String(c?.body ?? '').includes(HEARTBEAT_MARKER));
  return hits.length ? hits[hits.length - 1] : null;
}

function firstLine(body) {
  return String(body ?? '').split('\n')[0];
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
  });
}

function flag(argv, name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
}

function renderInbox(payload, { generation, all }) {
  const repo = payload?.data?.repository ?? {};
  const rows = [
    ...(repo.issues?.nodes ?? []).map((n) => ({ ...n, kind: 'issue' })),
    ...(repo.pullRequests?.nodes ?? []).map((n) => ({ ...n, kind: 'PR' })),
  ].map((n) => {
    const last = n.comments?.nodes?.[0] ?? null;
    const labels = (n.labels?.nodes ?? []).map((l) => l.name);
    // No comments at all and no labels ⇒ operator-authored and untriaged.
    // Otherwise: is the last thing said an operator message?
    const waiting = last === null ? labels.length === 0 : classify(last.body, generation) === 'operator';
    return { ...n, last, labels, waiting };
  });

  const out = [];
  for (const r of rows) {
    if (!all && !r.waiting) continue;
    out.push(`${r.waiting ? '●' : ' '} ${r.kind.padEnd(5)} #${String(r.number).padEnd(4)} ${r.title}`);
    out.push(`        ${r.last?.createdAt ?? r.updatedAt}  [${r.labels.join(',') || 'no labels'}]`);
    // First LINE, not a byte slice: the no-truncation policy exists so meaning
    // is never silently destroyed.
    out.push(`        ${firstLine(r.last?.body ?? '(no comments — untriaged)')}`);
    if (r.last?.url) out.push(`        ${r.last.url}`);
    out.push('');
  }
  out.push("● = last word is the operator's; nobody has replied.");
  if (!all) out.push('  (--all to include threads already answered)');
  return out.join('\n');
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const generation = flag(argv, 'generation');
  const input = await readStdin();

  if (command === 'classify') {
    process.stdout.write(`${classify(input, generation)}\n`);
    return;
  }

  if (command === 'unanswered') {
    const owner = flag(argv, 'owner');
    const rows = unanswered(flattenPages(JSON.parse(input || '[]')), { owner, generation });
    for (const c of rows) {
      process.stdout.write(`- [${c.created_at}] ${c.html_url}\n  ${firstLine(c.body)}\n`);
    }
    return;
  }

  if (command === 'heartbeat') {
    // `id<TAB>updated_at`, or nothing at all if the channel has never beat.
    const hb = latestHeartbeat(flattenPages(JSON.parse(input || '[]')));
    if (hb) process.stdout.write(`${hb.id}\t${hb.updated_at}\t${String(hb.body ?? '').replace(/\n/g, '\\n')}\n`);
    return;
  }

  if (command === 'inbox') {
    process.stdout.write(
      `${renderInbox(JSON.parse(input || '{}'), { generation, all: argv.includes('--all') })}\n`
    );
    return;
  }

  process.stderr.write('usage: comments.mjs classify|unanswered|inbox [--owner L] [--generation vN] [--all]\n');
  process.exitCode = 2;
}

main();
