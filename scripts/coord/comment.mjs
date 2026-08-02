#!/usr/bin/env node
// Post a GitHub comment that is guaranteed to carry a valid authorship marker.
//
// The enforcement hook blocks unmarked comments; this is the path of least
// resistance in the other direction, so getting it right is easier than getting
// it wrong. Set COORD_AGENT_NAME once at the start of a session and every
// comment is signed automatically — which is also what #79 asks for: a subagent
// with a name the operator can refer to later.
//
//   COORD_AGENT_NAME=Mira node scripts/coord/comment.mjs --pr 90 --body "cycle 2 green"
//   node scripts/coord/comment.mjs --issue 66 --coordinator v2 --body "..." --dry-run
//
// Plain node, no dependencies, no runtime-specific assumptions — it shells out
// to `gh` exactly like a human would.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { classifyComment, markerFor } = await import(
  pathToFileURL(resolve(HERE, 'marker.mjs')).href
);

const arg = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

function main(argv) {
  const issue = arg(argv, '--issue');
  const pr = arg(argv, '--pr');
  const generation = arg(argv, '--coordinator');
  const name = arg(argv, '--agent') ?? process.env.COORD_AGENT_NAME;
  const bodyFile = arg(argv, '--body-file');
  const dryRun = argv.includes('--dry-run');
  let body = arg(argv, '--body');

  if (bodyFile) body = bodyFile === '-' ? readFileSync(0, 'utf8') : readFileSync(bodyFile, 'utf8');
  if (!body) {
    process.stderr.write('comment: --body or --body-file is required\n');
    return 2;
  }
  if (!issue && !pr) {
    process.stderr.write('comment: --issue N or --pr N is required\n');
    return 2;
  }

  let marker;
  if (generation) {
    marker = markerFor({ role: 'coordinator', generation });
  } else {
    if (!name) {
      process.stderr.write(
        'comment: no agent name. Set COORD_AGENT_NAME (a short human first name) or pass --agent.\n' +
          'Every comment is signed so the operator can tell agents apart and refer to you later (#79).\n',
      );
      return 2;
    }
    marker = markerFor({ role: 'agent', name });
  }

  // Already marked? Leave the agent's words exactly as written.
  const existing = classifyComment(body);
  const finalBody = existing.isMachine && existing.valid ? body : `${marker} ${body.trimStart()}`;

  const check = classifyComment(finalBody);
  if (!check.isMachine || !check.valid) {
    process.stderr.write(`comment: refusing to post an unmarked body (${check.reason})\n`);
    return 2;
  }

  if (dryRun) {
    process.stdout.write(`${finalBody}\n`);
    return 0;
  }

  const target = issue ? ['issue', 'comment', issue] : ['pr', 'comment', pr];
  const r = spawnSync('gh', [...target, '--body', finalBody], { stdio: 'inherit', shell: false });
  return r.status ?? 1;
}

process.exitCode = main(process.argv.slice(2));
