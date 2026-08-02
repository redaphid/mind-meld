import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The classifier is a provider-agnostic plain-node module under scripts/coord/
// so any agent runtime (or a bash script) can call it. It is imported through a
// runtime-built specifier so tsc never pulls scripts/ into the src program.
const here = dirname(fileURLToPath(import.meta.url));
const MARKER_MODULE = pathToFileURL(resolve(here, '../../scripts/coord/marker.mjs')).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let marker: any;
beforeAll(async () => {
  marker = await import(/* @vite-ignore */ MARKER_MODULE);
});

const ROBOT = '\u{1F916}';

describe('classifyComment: coordinator', () => {
  it('recognizes the canonical coordinator marker and its generation', () => {
    const c = marker.classifyComment(`${ROBOT} **Coordinator v2:** deployed 1.13.0`);
    expect(c.actor).toBe('coordinator');
    expect(c.isMachine).toBe(true);
    expect(c.isCoordinatorReply).toBe(true);
    expect(c.generation).toBe('v2');
    expect(c.valid).toBe(true);
  });

  it('accepts a coordinator marker without bold', () => {
    const c = marker.classifyComment(`${ROBOT} Coordinator v11: cycle complete`);
    expect(c.actor).toBe('coordinator');
    expect(c.generation).toBe('v11');
  });

  it('matches the marker produced by coord_marker() in scripts/coord/lib.sh', () => {
    // lib.sh: coord_marker() { printf '🤖 **Coordinator %s:**' "$1"; }
    const c = marker.classifyComment(`${ROBOT} **Coordinator v3:** heartbeat`);
    expect(c.isCoordinatorReply).toBe(true);
  });
});

describe('classifyComment: agent', () => {
  it('recognizes a named agent and extracts the name', () => {
    const c = marker.classifyComment(`${ROBOT} **Agent (Mira):** cycle 1 green`);
    expect(c.actor).toBe('agent');
    expect(c.isMachine).toBe(true);
    expect(c.name).toBe('Mira');
    expect(c.valid).toBe(true);
  });

  it('does NOT count an agent comment as a reply to the operator', () => {
    // The S3 bug: an agent's marked comment must never bury an unanswered
    // operator message. Only the coordinator answers the operator.
    const c = marker.classifyComment(`${ROBOT} **Agent (Mira):** pushed cycle 3`);
    expect(c.isMachine).toBe(true);
    expect(c.isCoordinatorReply).toBe(false);
  });

  it('treats an unnamed agent marker as machine-authored but not protocol-valid', () => {
    const c = marker.classifyComment(`${ROBOT} **Agent:** cycle 2 green`);
    expect(c.actor).toBe('agent');
    expect(c.isMachine).toBe(true);
    expect(c.valid).toBe(false);
    expect(c.reason).toMatch(/name/i);
  });

  it('rejects the literal placeholder from the docs as a name', () => {
    const c = marker.classifyComment(`${ROBOT} **Agent (<name>):** oops`);
    expect(c.valid).toBe(false);
  });

  it('accepts hyphenated and two-part names', () => {
    expect(marker.classifyComment(`${ROBOT} **Agent (Mary-Jo):** hi`).name).toBe('Mary-Jo');
    expect(marker.classifyComment(`${ROBOT} **Agent (Jean Luc):** hi`).name).toBe('Jean Luc');
  });

  it('tolerates a variation selector after the robot emoji', () => {
    const c = marker.classifyComment(`${ROBOT}️ **Agent (Mira):** hi`);
    expect(c.actor).toBe('agent');
    expect(c.valid).toBe(true);
  });

  it('tolerates extra whitespace inside the marker', () => {
    const c = marker.classifyComment(`${ROBOT}   **Agent ( Mira ):**  hi`);
    expect(c.name).toBe('Mira');
  });
});

describe('classifyComment: whitespace and invisible characters', () => {
  it('ignores leading blank lines and indentation', () => {
    const c = marker.classifyComment(`\n\n   ${ROBOT} **Agent (Mira):** hi`);
    expect(c.actor).toBe('agent');
  });

  it('ignores a leading byte-order mark', () => {
    const c = marker.classifyComment(`﻿${ROBOT} **Agent (Mira):** hi`);
    expect(c.actor).toBe('agent');
  });

  it('ignores a leading zero-width space', () => {
    const c = marker.classifyComment(`​${ROBOT} **Agent (Mira):** hi`);
    expect(c.actor).toBe('agent');
  });

  it('handles CRLF bodies (GitHub returns them)', () => {
    const c = marker.classifyComment(`${ROBOT} **Agent (Mira):** hi\r\nmore text\r\n`);
    expect(c.actor).toBe('agent');
  });
});

describe('classifyComment: HTML comments', () => {
  it('sees through a leading HTML comment to the marker beneath it', () => {
    // This is the heartbeat body shape from scripts/coord/heartbeat.sh.
    const body = `<!-- coord-heartbeat -->\n${ROBOT} **Coordinator v2:** heartbeat — last cycle`;
    const c = marker.classifyComment(body);
    expect(c.actor).toBe('coordinator');
    expect(c.isCoordinatorReply).toBe(true);
  });

  it('treats a bare coord HTML marker as machine infrastructure, not an operator message', () => {
    const c = marker.classifyComment('<!-- coord-heartbeat -->\nstill alive');
    expect(c.isMachine).toBe(true);
    expect(c.actor).toBe('infra');
    expect(c.isCoordinatorReply).toBe(false);
  });

  it('sees through several stacked HTML comments', () => {
    const body = `<!-- a -->\n<!-- b -->\n${ROBOT} **Agent (Mira):** hi`;
    expect(marker.classifyComment(body).actor).toBe('agent');
  });

  it('does not treat an unrelated HTML comment as a machine marker', () => {
    const c = marker.classifyComment('<!-- not ours -->\nplease fix the parser');
    expect(c.isMachine).toBe(false);
    expect(c.actor).toBe('human');
  });
});

describe('classifyComment: quoting must not launder authorship', () => {
  it('classifies a quoted marker as human — the operator is quoting an agent', () => {
    const body = `> ${ROBOT} **Agent (Mira):** cycle 1 green\n\nno, do it the other way`;
    const c = marker.classifyComment(body);
    expect(c.isMachine).toBe(false);
    expect(c.actor).toBe('human');
  });

  it('classifies a marker inside a fenced code block as human', () => {
    const body = '```\n' + `${ROBOT} **Agent (Mira):** example\n` + '```\n';
    expect(marker.classifyComment(body).isMachine).toBe(false);
  });

  it('does not accept a marker that appears only later in the body', () => {
    const body = `here is what I want\n\n${ROBOT} **Agent (Mira):** hi`;
    expect(marker.classifyComment(body).isMachine).toBe(false);
  });
});

describe('classifyComment: infrastructure markers', () => {
  it.each(['\u{1F50E}', '⏱️', '⏱'])('treats %s as machine infrastructure', (emoji) => {
    const c = marker.classifyComment(`${emoji} automated sweep result`);
    expect(c.isMachine).toBe(true);
    expect(c.actor).toBe('infra');
    expect(c.isCoordinatorReply).toBe(false);
  });
});

describe('classifyComment: unmarked and degenerate bodies', () => {
  it.each([
    ['plain operator text', 'please rebase this'],
    ['empty', ''],
    ['whitespace only', '   \n\t '],
    ['a robot emoji mid-sentence', 'the 🤖 marker is missing here'],
  ])('classifies %s as human', (_label, body) => {
    const c = marker.classifyComment(body);
    expect(c.isMachine).toBe(false);
    expect(c.actor).toBe('human');
  });

  it.each([[null], [undefined], [42], [{}]])('never throws on non-string input: %s', (body) => {
    expect(() => marker.classifyComment(body)).not.toThrow();
    expect(marker.classifyComment(body).isMachine).toBe(false);
  });

  it('treats a bare robot emoji with no role as machine but invalid, and never as a coordinator reply', () => {
    const c = marker.classifyComment(`${ROBOT} something happened`);
    expect(c.isMachine).toBe(true);
    expect(c.valid).toBe(false);
    expect(c.isCoordinatorReply).toBe(false);
  });

  it('does not mistake a look-alike emoji for the robot', () => {
    expect(marker.classifyComment('\u{1F47E} **Agent (Mira):** hi').isMachine).toBe(false);
  });
});

describe('markerFor', () => {
  it('builds an agent marker that its own classifier accepts', () => {
    const m = marker.markerFor({ role: 'agent', name: 'Mira' });
    expect(m).toBe(`${ROBOT} **Agent (Mira):**`);
    expect(marker.classifyComment(`${m} hi`).valid).toBe(true);
  });

  it('builds a coordinator marker identical to coord_marker() in lib.sh', () => {
    expect(marker.markerFor({ role: 'coordinator', generation: 'v4' })).toBe(
      `${ROBOT} **Coordinator v4:**`,
    );
  });
});

describe('unansweredOperatorComments', () => {
  const owner = 'redaphid';
  const c = (over: Record<string, unknown>) => ({
    id: 1,
    user: { login: owner },
    author_association: 'OWNER',
    created_at: '2026-08-01T00:00:00Z',
    html_url: 'https://example.invalid/1',
    body: 'x',
    ...over,
  });

  it('returns operator comments that arrived after the last coordinator reply', () => {
    const out = marker.unansweredOperatorComments(
      [
        c({ id: 1, created_at: '2026-08-01T01:00:00Z', body: 'first ask' }),
        c({ id: 2, created_at: '2026-08-01T02:00:00Z', body: `${ROBOT} **Coordinator v2:** on it` }),
        c({ id: 3, created_at: '2026-08-01T03:00:00Z', body: 'second ask' }),
      ],
      owner,
    );
    expect(out.map((x: { id: number }) => x.id)).toEqual([3]);
  });

  it('an agent comment does NOT bury an unanswered operator message', () => {
    const out = marker.unansweredOperatorComments(
      [
        c({ id: 1, created_at: '2026-08-01T01:00:00Z', body: 'please look at this' }),
        c({
          id: 2,
          created_at: '2026-08-01T02:00:00Z',
          body: `${ROBOT} **Agent (Mira):** pushed cycle 3`,
        }),
      ],
      owner,
    );
    expect(out.map((x: { id: number }) => x.id)).toEqual([1]);
  });

  it('does not report the heartbeat comment as an operator message', () => {
    const out = marker.unansweredOperatorComments(
      [c({ id: 9, body: '<!-- coord-heartbeat -->\n🤖 **Coordinator v2:** heartbeat' })],
      owner,
    );
    expect(out).toEqual([]);
  });

  it('ignores comments from anyone but the repo owner — the repo is public', () => {
    const out = marker.unansweredOperatorComments(
      [c({ id: 5, user: { login: 'stranger' }, author_association: 'NONE', body: 'hello' })],
      owner,
    );
    expect(out).toEqual([]);
  });
});

describe('lastWordIsOperators (inbox semantics)', () => {
  it('is true when the last comment is unmarked', () => {
    expect(marker.lastWordIsOperators({ body: 'ping?' })).toBe(true);
  });

  it('is false when the last comment carries any machine marker', () => {
    expect(marker.lastWordIsOperators({ body: `${ROBOT} **Agent (Mira):** working` })).toBe(false);
    expect(marker.lastWordIsOperators({ body: '<!-- coord-heartbeat -->\nalive' })).toBe(false);
  });

  it('treats a thread with no comments as untriaged, not as waiting', () => {
    expect(marker.lastWordIsOperators(null)).toBe(false);
  });
});
