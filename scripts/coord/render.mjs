#!/usr/bin/env node
// Render a `gh ... list --json` result, and refuse to truncate quietly.
//
// `gh issue list` / `gh pr list` default to `--limit 30` and give no signal at
// all when they cut the result off. With 46 open issues, the section of
// state.sh headed "Unlabeled — operator-authored, AUTHORITATIVE" printed 8 of
// 14 and dropped the six OLDEST — precisely the asks most likely to have been
// forgotten already. #80's own verification then cited that truncated count as
// evidence the script was correct.
//
// A cap is not a bug; a cap you cannot see is. Every list now passes an
// explicit limit and this prints a loud, in-band warning when the result
// reaches it, in the same markdown that goes into the channel comment.
//
//   gh pr list --limit 500 --json ... | render.mjs prs       --limit 500
//   gh issue list --limit 500 --json ... | render.mjs numbers   --limit 500
//   gh issue list --limit 500 --json ... | render.mjs unlabeled --limit 500

function flag(argv, name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
  });
}

/**
 * Warn on the RAW fetched count, never the filtered one: a filter applied after
 * a capped fetch cannot tell you what the cap hid.
 */
/**
 * Absence of data is not an empty list.
 *
 * Every consumer of these renderers reads them as fact. If a fetch fails —
 * auth expired, network gone, a malformed response — parsing "" as `[]` prints
 * "- none", which is a confident claim that there is nothing there. That is the
 * same failure as the silent truncation this file exists to prevent, only
 * total: absence presented as knowledge. So a caller must hand us a real JSON
 * array or we refuse, loudly and nonzero.
 */
export function parseRowsOrDie(raw, what) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) return parsed;
  process.stdout.write(
    `- 🚨 **NO DATA — THIS IS NOT AN EMPTY LIST.** The ${what} query returned nothing parseable, so its result is UNKNOWN. Do not read this section as "there is nothing here".\n`
  );
  process.exitCode = 1;
  return null;
}

export function truncationWarning(rawCount, limit, what) {
  if (rawCount < limit) return null;
  return `- 🚨 **TRUNCATED — THIS LIST IS INCOMPLETE.** ${what} hit the ${limit}-row cap; there are more. Re-run with a higher \`COORD_LIST_LIMIT\`. Do not treat what follows as authoritative.`;
}

export function renderPrs(rows) {
  if (!rows.length) return ['- none'];
  return rows.map(
    (p) =>
      `- #${p.number} ${p.isDraft ? '(draft) ' : ''}${p.title} — \`${p.headRefName}\`, updated ${p.updatedAt}`
  );
}

export function renderNumbers(rows) {
  return [rows.map((r) => `#${r.number}`).join(', ')];
}

export function renderUnlabeled(rows) {
  const hits = rows.filter((r) => (r.labels ?? []).length === 0);
  if (!hits.length) return ['- none'];
  return hits.map((r) => `- #${r.number} ${r.title}`);
}

async function main() {
  const [mode, ...argv] = process.argv.slice(2);
  const limit = Number(flag(argv, 'limit', '500'));

  const renderers = { prs: renderPrs, numbers: renderNumbers, unlabeled: renderUnlabeled };
  const render = renderers[mode];
  if (!render) {
    process.stderr.write(`usage: render.mjs ${Object.keys(renderers).join('|')} --limit N\n`);
    process.exitCode = 2;
    return;
  }

  const rows = parseRowsOrDie(await readStdin(), mode);
  if (rows === null) return;

  const warning = truncationWarning(rows.length, limit, mode);
  const lines = render(rows);
  // join, never interpolate: a title containing a comma must survive intact,
  // and `numbers` deliberately joins with ", " itself.
  process.stdout.write(`${(warning ? [warning, ...lines] : lines).join('\n')}\n`);
}

main();
