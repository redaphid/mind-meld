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
  // `needs-human` is how a thread is held for the operator's attention, so an
  // agent's own report releasing that hold is the burial bug wearing a label.
  // This asserts the behaviour of the script that actually makes the decision.
  const AGENT_REPORT =
    'Cycle 3 green: the reconciler now splits conclusive from stylistic signals, so structure alone\n' +
    'can never trigger an edit.\n\n24 tests passing, type-check clean.\n\nNext: the docs.';

  it('the rule in reconcile-labels.mjs consults machine authorship, not just the marker', () => {
    const src = readFileSync(resolve(here, '../../scripts/comms/reconcile-labels.mjs'), 'utf8');
    const rule = src.slice(src.indexOf("labels.includes('needs-human')"));
    expect(rule).toMatch(/machineAuthorship\([^)]*\)\.isMachine/);
  });

  it('classifies an unmarked agent report as a machine, and a terse human reply as not', async () => {
    const rec = await load('../../scripts/coord/marker-reconcile.mjs');
    expect(comms.isAgentMarked(AGENT_REPORT)).toBe(false); // unmarked, as posted
    expect(rec.machineAuthorship(AGENT_REPORT).isMachine).toBe(true);
    expect(rec.machineAuthorship('no, use the other one').isMachine).toBe(false);
    expect(rec.machineAuthorship('verdict: this is not what I asked for').isMachine).toBe(false);
  });
});

describe('the single-source rule is an invariant, not a list of files', () => {
  it('no script outside marker.mjs carries its own marker-matching regex', async () => {
    // The first version of this test grepped three files by name, so adding a
    // fourth definition passed. Scan everything instead.
    const { globSync } = await import('node:fs');
    const roots = ['../../scripts', '../../.claude'];
    const files: string[] = [];
    for (const root of roots) {
      try {
        files.push(
          ...globSync('**/*.{mjs,sh,js,ts}', { cwd: resolve(here, root) }).map((f) =>
            resolve(here, root, String(f)),
          ),
        );
      } catch {
        /* directory may not exist */
      }
    }
    expect(files.length).toBeGreaterThan(5);

    const ROBOT = '\u{1F916}';
    const offenders: string[] = [];
    for (const file of files) {
      if (file.replace(/\\/g, '/').endsWith('scripts/coord/marker.mjs')) continue; // the one definition
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(#|\*|\/\/|\/\*)/.test(l))
        .join('\n');
      // Any test of a body against a marker emoji, in any language.
      if (
        new RegExp(`(test|match|=~|startswith|startsWith|grep)[^\\n]{0,40}${ROBOT}`, 'u').test(code) ||
        new RegExp(`${ROBOT}[^\\n]{0,20}\\|`, 'u').test(code) ||
        /startswith\("\\u{0,1}1?F?916/.test(code)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
