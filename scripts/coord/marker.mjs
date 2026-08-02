#!/usr/bin/env node
// One definition of "who wrote this comment", for every tool that needs it.
//
// Everyone — the operator, the coordinator, and every subagent — comments on
// GitHub under the SAME account. `user.login` therefore says nothing about
// authorship. The leading marker is the only signal, which makes its parsing
// load-bearing rather than cosmetic: get it wrong in one direction and the
// coordinator chases phantom operator messages; get it wrong in the other and a
// machine comment BURIES a real question the operator is waiting on.
//
// It lived in two places that disagreed (`inbox.sh` matched /^\s*(🤖|🔎|⏱️)/,
// `lib.sh` matched startswith("🤖")) and neither saw through the HTML comment
// that every heartbeat body starts with. So: one module, one grammar, tested.
//
// Plain node, zero dependencies, no framework imports — a bash script, a CI
// job, or any agent runtime can shell out to the CLI below. Nothing here knows
// what model or vendor is calling it.
//
//   node scripts/coord/marker.mjs classify < body.md
//   node scripts/coord/marker.mjs check --body "..."        # exit 1 if unmarked
//   node scripts/coord/marker.mjs marker --agent Mira
//   gh api ... | node scripts/coord/marker.mjs unanswered --owner redaphid

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The marker grammar, in one place. */
export const ROBOT = '\u{1F916}'; // 🤖 — machine-authored
const VS16 = '\uFE0F'; // optional emoji variation selector
// Infrastructure emoji already in use by coordinator tooling (inbox.sh).
const INFRA_EMOJI = ['\u{1F50E}', '\u{1F50D}', '\u23F1', '\u{1F4CB}'];
/** HTML comments that identify machine-generated infrastructure bodies. */
const INFRA_HTML = /^<!--\s*coord-[a-z0-9-]+\s*-->$/i;

// Invisible characters GitHub, editors, and copy-paste like to leave in front
// of a marker. Stripping them is not politeness — a BOM would otherwise turn a
// perfectly marked agent comment into a false "the operator is waiting" alarm.
const INVISIBLE = /^[\uFEFF\u200B-\u200D\u2060\u00A0\s]+/;

const AGENT_NAME = /^[\p{L}][\p{L}\p{M}'\- ]{0,39}$/u;
const PLACEHOLDER_NAMES = new Set(['name', 'your name', 'agent', 'yourname', 'tbd']);

const MARKER_RE = new RegExp(
  `^${ROBOT}${VS16}?\\s*` +
    `(?:\\*\\*|__)?\\s*` +
    `(?:(?<coordinator>Coordinator)\\s*(?<generation>v?\\d+)?` +
    `|(?<agent>Agent)(?:\\s*\\(\\s*(?<name>[^)\\n]{0,60}?)\\s*\\))?)` +
    `\\s*:?\\s*(?:\\*\\*|__)?\\s*:?`,
  'iu',
);

const INFRA_RE = new RegExp(`^(?:${INFRA_EMOJI.join('|')})${VS16}?`, 'u');

function result(over) {
  return {
    actor: 'human',
    isMachine: false,
    isCoordinatorReply: false,
    valid: false,
    name: null,
    generation: null,
    marker: null,
    reason: 'no authorship marker',
    ...over,
  };
}

/**
 * Classify a comment body by its leading authorship marker.
 *
 * The marker must open the comment: leading whitespace, invisible characters
 * and machine HTML comments are skipped, but a marker inside a blockquote or a
 * code fence, or one that shows up further down the body, does NOT count. That
 * strictness is the point — the operator quoting an agent must never read as
 * the agent, and "somewhere in there I said who I was" is not a protocol.
 *
 * @param {unknown} body raw comment body from the GitHub API
 * @returns {{actor:'coordinator'|'agent'|'infra'|'human', isMachine:boolean,
 *   isCoordinatorReply:boolean, valid:boolean, name:string|null,
 *   generation:string|null, marker:string|null, reason:string}}
 */
export function classifyComment(body) {
  if (typeof body !== 'string' || body.length === 0) {
    return result({ reason: 'empty or non-text body' });
  }

  let rest = body.replace(/\r\n/g, '\n');
  let sawInfraHtml = false;

  // Peel leading whitespace and HTML comments. The heartbeat body opens with
  // `<!-- coord-heartbeat -->`, which used to make it look operator-authored.
  for (;;) {
    const before = rest;
    rest = rest.replace(INVISIBLE, '');
    const html = /^<!--[\s\S]*?-->/.exec(rest);
    if (html) {
      if (INFRA_HTML.test(html[0].trim())) sawInfraHtml = true;
      rest = rest.slice(html[0].length);
    }
    if (rest === before) break;
  }

  const m = MARKER_RE.exec(rest);
  if (m) {
    const marker = m[0].trim();
    const g = m.groups ?? {};
    if (g.coordinator) {
      const generation = g.generation ? (/^v/i.test(g.generation) ? g.generation : `v${g.generation}`) : null;
      return result({
        actor: 'coordinator',
        isMachine: true,
        // ONLY the coordinator's marker means "the operator has been answered".
        isCoordinatorReply: true,
        valid: Boolean(generation),
        generation,
        marker,
        reason: generation ? 'coordinator marker' : 'coordinator marker without a generation',
      });
    }
    if (g.agent) {
      const name = (g.name ?? '').trim();
      const named = name.length > 0 && AGENT_NAME.test(name) && !PLACEHOLDER_NAMES.has(name.toLowerCase());
      return result({
        actor: 'agent',
        isMachine: true,
        // An agent speaking is NOT the operator being answered. This is the
        // whole reason agent and coordinator markers are distinguishable.
        isCoordinatorReply: false,
        valid: named,
        name: named ? name : null,
        marker,
        reason: named
          ? 'named agent marker'
          : 'agent marker is missing a name — use 🤖 **Agent (YourName):**',
      });
    }
  }

  // A robot emoji with no role at all: machine-authored, but it does not say
  // which machine, so it can never count as the coordinator answering.
  if (rest.startsWith(ROBOT)) {
    return result({
      actor: 'agent',
      isMachine: true,
      valid: false,
      marker: ROBOT,
      reason: 'robot marker without a role — use 🤖 **Agent (Name):** or 🤖 **Coordinator vN:**',
    });
  }

  const infra = INFRA_RE.exec(rest);
  if (infra) {
    return result({
      actor: 'infra',
      isMachine: true,
      valid: true,
      marker: infra[0],
      reason: 'automated tooling marker',
    });
  }

  if (sawInfraHtml) {
    return result({
      actor: 'infra',
      isMachine: true,
      valid: true,
      marker: 'coord html marker',
      reason: 'machine-generated infrastructure comment',
    });
  }

  return result({ reason: 'no authorship marker at the start of the comment' });
}

/** Build a marker the classifier is guaranteed to accept. */
export function markerFor({ role, name, generation } = {}) {
  if (role === 'coordinator') {
    const g = /^v/i.test(String(generation ?? '')) ? generation : `v${generation}`;
    return `${ROBOT} **Coordinator ${g}:**`;
  }
  return `${ROBOT} **Agent (${name}):**`;
}

/** True when the last comment on a thread is unmarked — i.e. the operator's. */
export function lastWordIsOperators(lastComment) {
  if (!lastComment || typeof lastComment.body !== 'string') return false;
  return !classifyComment(lastComment.body).isMachine;
}

/**
 * Operator comments that arrived after the coordinator's last reply.
 *
 * Only the repo owner counts as the operator (the repo is public), and only a
 * COORDINATOR marker closes the loop — an agent's progress comment must not
 * bury a question the operator is still waiting on.
 */
export function unansweredOperatorComments(comments, ownerLogin) {
  const mine = (Array.isArray(comments) ? comments : []).filter(
    (c) => c?.user?.login === ownerLogin && (c.author_association ?? 'OWNER') === 'OWNER',
  );
  const lastReplyAt = mine
    .filter((c) => classifyComment(c.body).isCoordinatorReply)
    .map((c) => c.created_at)
    .sort()
    .pop();
  return mine.filter(
    (c) =>
      !classifyComment(c.body).isMachine && (lastReplyAt === undefined || c.created_at > lastReplyAt),
  );
}

// ---------------------------------------------------------------------------
// CLI — so bash and non-JS runtimes get the same answers as the node callers.

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Comments from stdin, as either a JSON array or JSONL.
 *
 * `gh api --paginate` emits one array PER PAGE, so callers flatten it with
 * `--jq '.[]'` and hand us a stream of objects. Accepting both means a thread
 * with more than 30 comments does not silently parse as nothing — which would
 * report an empty inbox and look exactly like "nobody is waiting on us".
 */
function parseComments(raw) {
  const text = (raw ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* fall through to JSONL */
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write('marker: skipping an unparseable comment record\n');
    }
  }
  return out;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'classify': {
      const body = argValue(rest, '--body') ?? readStdin();
      const c = classifyComment(body);
      process.stdout.write(`${JSON.stringify(c)}\n`);
      return 0;
    }
    case 'check': {
      // Exit 0 when the body carries a protocol-valid marker, 1 otherwise, with
      // an actionable message. This is what the pre-comment hook leans on.
      const body = argValue(rest, '--body') ?? readStdin();
      const c = classifyComment(body);
      if (c.isMachine && c.valid) return 0;
      process.stderr.write(`${c.reason}\n`);
      return 1;
    }
    case 'marker': {
      const agent = argValue(rest, '--agent');
      const gen = argValue(rest, '--coordinator');
      process.stdout.write(
        `${agent ? markerFor({ role: 'agent', name: agent }) : markerFor({ role: 'coordinator', generation: gen })}\n`,
      );
      return 0;
    }
    case 'unanswered': {
      const owner = argValue(rest, '--owner');
      const comments = parseComments(readStdin());
      for (const c of unansweredOperatorComments(comments, owner)) {
        const first = String(c.body ?? '').split('\n')[0];
        process.stdout.write(`- [${c.created_at}] ${c.html_url}\n  ${first}\n`);
      }
      return 0;
    }
    case 'annotate': {
      // Adds `{marker: {...}}` to each comment on stdin, for inbox-style tools.
      const out = parseComments(readStdin()).map((c) => ({
        ...c,
        marker: classifyComment(c?.body),
      }));
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        'usage: marker.mjs <classify|check|marker|unanswered|annotate> [--body TEXT] [--owner LOGIN] [--agent NAME] [--coordinator vN]\n',
      );
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
