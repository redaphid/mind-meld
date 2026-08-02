import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The whole point of this change is that "is this machine-authored?" has ONE
// answer. These tests fail if a second definition reappears anywhere.
const here = dirname(fileURLToPath(import.meta.url));
const load = (rel: string) => import(/* @vite-ignore */ pathToFileURL(resolve(here, rel)).href);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let marker: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let comms: any;
beforeAll(async () => {
  marker = await load('../../scripts/coord/marker.mjs');
  comms = await load('../../scripts/comms/lib.mjs');
});

const ROBOT = '\u{1F916}';

describe('scripts/comms/lib.mjs delegates to the shared classifier', () => {
  it.each([
    ['a named agent comment', `${ROBOT} **Agent (Mira):** cycle 3 green`, true],
    ['a coordinator comment', `${ROBOT} **Coordinator v2:** on it`, true],
    ['a heartbeat, which opens with an HTML comment', '<!-- coord-heartbeat -->\nalive', true],
    ['an adversarial review marker', '\u{1F50E} **Adversarial review (Rosa):** verdict', true],
    ['a plain operator instruction', "Don't put it in `.claude/`", false],
    ['the operator quoting an agent', `> ${ROBOT} **Agent (Mira):** hi\n\nno, the other way`, false],
  ])('agrees with marker.mjs on %s', (_label, body, expected) => {
    expect(comms.isAgentMarked(body)).toBe(expected);
    expect(marker.classifyComment(body).isMachine).toBe(expected);
  });

  it('has no marker regex of its own left in the file', () => {
    // A second regex here is how the definitions drifted apart the first time:
    // inbox.sh matched one thing, lib.sh another, lib.mjs a third.
    const src = readFileSync(resolve(here, '../../scripts/comms/lib.mjs'), 'utf8');
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(codeOnly).not.toMatch(/\/\^\(?[\u{1F900}-\u{1FAFF}]/u);
  });
});

describe('the shared classifier is what inbox.sh uses', () => {
  it('inbox.sh no longer carries its own emoji test', () => {
    const src = readFileSync(resolve(here, '../../scripts/coord/inbox.sh'), 'utf8');
    expect(src).not.toMatch(/test\("\^\\\\s\*\(/);
    expect(src).toContain('marker.mjs');
  });

  it('scripts/coord/lib.sh no longer carries its own startswith test', () => {
    const src = readFileSync(resolve(here, '../../scripts/coord/lib.sh'), 'utf8');
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(codeOnly).not.toMatch(/startswith\("🤖"\)/);
    expect(codeOnly).toContain('marker.mjs');
  });
});

describe('an unmarked agent comment does not clear needs-human', () => {
  it('is not treated as the operator responding', () => {
    // reconcile-labels.mjs drops `needs-human` when the last OWNER comment is
    // unmarked. An unmarked AGENT report would therefore clear a label meant to
    // hold the thread for the operator — the same burial bug, different tool.
    const agentReport =
      'Cycle 3 green: 24 tests passing, type-check clean.\n\n## Next\n\nthe reconciler.';
    expect(comms.isAgentMarked(agentReport)).toBe(false); // unmarked, as posted
    // ...but the reconciler can now tell it apart from a two-line human reply.
    return load('../../scripts/coord/marker-reconcile.mjs').then((rec) => {
      expect(rec.machineAuthorship(agentReport).isMachine).toBe(true);
      expect(rec.machineAuthorship('no, use the other one').isMachine).toBe(false);
    });
  });
});
