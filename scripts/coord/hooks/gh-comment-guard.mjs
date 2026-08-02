#!/usr/bin/env node
// Refuse to let an unmarked comment reach GitHub.
//
// The authorship marker is the only thing separating the operator's words from
// a machine's, because everyone posts under the same account. Documenting the
// rule is how we ended up with 36 false "operator is waiting" alarms and 17
// genuinely unanswered operator messages at the same time. So the rule is
// checked at the only moment it can still be enforced: before `gh` runs.
//
// Design notes:
//   * It BLOCKS, it never rewrites. Silently editing an agent's words is worse
//     than making it fix them, and a rewritten body hides that a violation
//     happened at all.
//   * It fails CLOSED on a body it cannot read — an unreadable body is exactly
//     how unmarked comments escape — but fails OPEN on any internal error of
//     its own. A guard that can wedge a session is worse than no guard.
//   * It is plain node with no dependencies and no runtime-specific imports.
//     Claude Code wires it as a PreToolUse hook; anything else can call
//     `node scripts/coord/hooks/gh-comment-guard.mjs --command "<shell>"`.
//     Exit 0 = allow, exit 2 = block with the reason on stderr.
//
// This is a guardrail, not a sandbox: a body hidden behind `bash -c` or an
// unrelated wrapper script is not inspected. It catches the mistake, not the
// determined evasion.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { classifyComment, markerFor } = await import(
  pathToFileURL(resolve(HERE, '../marker.mjs')).href
);

const ALLOW = 0;
const BLOCK = 2;

/**
 * Split a shell command into tokens, tracking which ones the shell would have
 * expanded. A token containing an unquoted `$` is a body we cannot read, which
 * matters more than the token text itself.
 */
export function tokenize(command) {
  const tokens = [];
  let cur = '';
  let started = false;
  let expansion = false;
  let quote = null; // "'" or '"'
  const push = () => {
    if (started) tokens.push({ text: cur, expansion });
    cur = '';
    started = false;
    expansion = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        cur += command[++i];
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '$') expansion = true;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += command[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === '$') expansion = true;
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      push();
      tokens.push({ text: ch, text_operator: true, operator: true });
      continue;
    }
    cur += ch;
    started = true;
  }
  push();
  return tokens;
}

/** Split tokens into the individual commands the shell would run. */
function segments(tokens) {
  const out = [[]];
  for (const t of tokens) {
    if (t.operator) {
      if (out[out.length - 1].length) out.push([]);
    } else out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length);
}

const isGh = (t) => t?.text === 'gh' || /[/\\]gh(\.exe)?$/.test(t?.text ?? '');

// Wrappers and prefixes that ordinary commands wear: `env VAR=x gh ...`,
// `VAR=x gh ...`, `command gh ...`, `xargs -I{} gh ...`. These are idioms, not
// evasions, so the guard has to see through them or it only stops the careful.
const PREFIX_WORDS = new Set(['env', 'command', 'nohup', 'time', 'sudo', 'xargs', 'nice', 'stdbuf']);
const isPrefixToken = (t) =>
  PREFIX_WORDS.has(t.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text) || t.text.startsWith('-');

/** Drop wrapper words so the segment starts at `gh`, if it ever does. */
function unwrap(seg) {
  let i = 0;
  while (i < seg.length && !isGh(seg[i]) && isPrefixToken(seg[i])) i++;
  return i < seg.length && isGh(seg[i]) ? seg.slice(i) : seg;
}

/** Which comment-posting shape, if any, is this segment? */
export function commentKind(rawSeg) {
  const seg = unwrap(rawSeg);
  if (!isGh(seg[0])) return null;
  const [, a, b] = seg.map((t) => t.text);
  if ((a === 'issue' || a === 'pr') && b === 'comment') return 'comment';
  if (a === 'pr' && b === 'review') return 'review';
  if (a === 'api') {
    // Any argument can be the path (`--method PATCH` sits between `api` and it),
    // so look for the endpoint shape rather than guessing by position.
    const hasBody = seg.some((t) => /^body=/.test(t.text));
    // `--input file.json` and `--input -` carry the body where we cannot see
    // it. That is an ordinary way to post a long comment, so it must be
    // checked (and, being unreadable, refused) rather than waved through.
    const hasInput = seg.some((t) => t.text === '--input' || t.text.startsWith('--input='));
    const posts = seg.some((t) => /^[^-].*\/(comments|reviews)(\/[^/]*)?$/.test(t.text));
    if ((hasBody || hasInput) && posts) return 'api';
  }
  return null;
}

/** Pull the heredoc body out of a command, if it has exactly one. */
function heredocBody(text) {
  const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\n([\s\S]*?)\n[ \t]*\2\b/.exec(text);
  return m ? m[3] : null;
}

/**
 * Resolve the comment body a segment would post.
 * @returns {{body:string}|{unresolved:string}|{error:string}}
 */
export function resolveBody(seg, kind) {
  const val = (i) => seg[i]?.text;
  let raw = null;
  let fromFile = null;

  for (let i = 1; i < seg.length; i++) {
    const t = seg[i].text;
    if (kind === 'api') {
      const m = /^(?:body)=([\s\S]*)$/.exec(t);
      if (m) {
        raw = seg[i];
        // `-f body=@file` reads from a file, same as --body-file.
        if (m[1].startsWith('@')) fromFile = m[1].slice(1);
        else raw = { ...seg[i], text: m[1] };
        continue;
      }
      continue;
    }
    if (t === '--body' || t === '-b') raw = seg[i + 1];
    else if (t.startsWith('--body=')) raw = { ...seg[i], text: t.slice('--body='.length) };
    else if (t === '--body-file' || t === '-F') fromFile = val(i + 1);
    else if (t.startsWith('--body-file=')) fromFile = t.slice('--body-file='.length);
  }

  if (fromFile !== null && fromFile !== undefined) {
    if (fromFile === '-') return { unresolved: 'the body is piped in on stdin' };
    try {
      return { body: readFileSync(fromFile, 'utf8') };
    } catch {
      // Fail CLOSED. The hook runs from the project directory while worktree
      // agents pass paths relative to their own cwd, so an unreadable body file
      // is the ordinary case rather than a rare one — treating it as our bug
      // and allowing it would be a hole an agent walks through every day.
      return {
        unresolved: `the body file ${fromFile} could not be read from the hook's working directory`,
      };
    }
  }

  if (!raw) {
    // A review with a verdict and no body is a legitimate empty comment.
    if (kind === 'review') return { body: null };
    return { unresolved: 'no --body, --body-file, or body= argument was given' };
  }

  if (!raw.expansion) return { body: raw.text };

  // The shell would have expanded this. Recover the common agent patterns.
  const doc = heredocBody(raw.text);
  if (doc !== null) return { body: doc };
  const cat = /^\$\(\s*cat\s+([^\s)]+)\s*\)$/.exec(raw.text.trim());
  if (cat) {
    try {
      return { body: readFileSync(cat[1], 'utf8') };
    } catch {
      return { error: `could not read ${cat[1]}` };
    }
  }
  return { unresolved: 'the body comes from a shell expansion this hook cannot read' };
}

function blockMessage(reason, hint) {
  const example = markerFor({ role: 'agent', name: 'YourName' });
  return [
    `Blocked: ${reason}`,
    '',
    'Every agent, coordinator, and the operator comment on GitHub under the SAME',
    'account, so the leading marker is the only way to tell machine comments from',
    "the operator's. An unmarked machine comment either raises a false \"the operator",
    'is waiting" alarm or buries a real question the operator is waiting on.',
    '',
    `Start the comment body with your marker, e.g.  ${example}`,
    '  - an agent:      🤖 **Agent (Name):**   (pick a short human first name, keep it all task)',
    '  - the coordinator: 🤖 **Coordinator vN:**',
    '',
    hint ?? 'Then re-run the command with the marker as the first characters of the body.',
    'See docs/agent-authorship.md.',
  ].join('\n');
}

export function checkCommand(command) {
  for (const rawSeg of segments(tokenize(command))) {
    const kind = commentKind(rawSeg);
    if (!kind) continue;
    const seg = unwrap(rawSeg);

    const resolved = resolveBody(seg, kind);
    if (resolved.error) {
      return { decision: 'allow', warning: `marker guard: ${resolved.error} — failing open` };
    }
    if (resolved.unresolved) {
      return {
        decision: 'block',
        message: blockMessage(
          `this posts a GitHub comment but the marker guard could not read the body (${resolved.unresolved}).`,
          'Inline the body with --body "🤖 **Agent (Name):** ..." so the marker is verifiable, or pass --body-file with an ABSOLUTE path (this hook runs from the project directory, not your worktree).',
        ),
      };
    }
    if (resolved.body === null) continue; // review verdict with no comment body

    const c = classifyComment(resolved.body);
    if (c.isMachine && c.valid) continue;
    return {
      decision: 'block',
      message: blockMessage(
        `this GitHub comment has no valid authorship marker (${c.reason}).`,
        c.actor === 'agent' && !c.valid
          ? 'Name yourself in the marker — see #79. The name is how the operator refers to you later.'
          : undefined,
      ),
    };
  }
  return { decision: 'allow' };
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  let command;
  const ci = argv.indexOf('--command');
  if (ci !== -1) {
    command = argv[ci + 1];
  } else {
    const raw = readStdin();
    if (!raw.trim()) return ALLOW;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return ALLOW; // not a hook payload we understand
    }
    if (payload?.tool_name && payload.tool_name !== 'Bash') return ALLOW;
    command = payload?.tool_input?.command;
  }
  if (typeof command !== 'string' || !command.trim()) return ALLOW;

  const verdict = checkCommand(command);
  if (verdict.warning) process.stderr.write(`${verdict.warning}\n`);
  if (verdict.decision === 'block') {
    process.stderr.write(`${verdict.message}\n`);
    return BLOCK;
  }
  return ALLOW;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Never wedge a session on our own bug.
    process.stderr.write(`marker guard: internal error, failing open (${err?.message})\n`);
    process.exitCode = ALLOW;
  }
}
