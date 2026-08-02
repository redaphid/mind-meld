// Black-box tests for the coordinator's comment classifier.
//
// This is the piece whose failure is INVISIBLE: when it misclassifies, an
// operator message is silently marked answered and nobody ever sees it again.
// A post-merge adversarial review found exactly that on live data — an
// implementation agent's `🤖 **Agent (...):**` status post was counted as
// "the coordinator replied to you", burying three operator directives.
//
// So the rules are pinned here, spawning the real script the way the shell
// scripts do, with no import coupling to src/.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../scripts/coord/comments.mjs');

function run(args: string[], stdin: string): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

const OWNER = 'redaphid';

type Comment = {
  id: number;
  body: string;
  login?: string;
  association?: string;
};

/** Build the shape `gh api repos/:o/:r/issues/:n/comments` actually returns. */
function comments(list: Comment[]): string {
  return JSON.stringify(
    list.map((c) => ({
      id: c.id,
      body: c.body,
      created_at: `2026-08-02T00:00:${String(c.id).padStart(2, '0')}Z`,
      updated_at: `2026-08-02T00:00:${String(c.id).padStart(2, '0')}Z`,
      html_url: `https://github.com/redaphid/mind-meld/issues/1#issuecomment-${c.id}`,
      user: { login: c.login ?? OWNER },
      author_association: c.association ?? 'OWNER',
    }))
  );
}

function classify(body: string, generation = 'v2'): string {
  return run(['classify', '--generation', generation], body).trim();
}

function unanswered(list: Comment[], generation = 'v2'): string {
  return run(['unanswered', '--owner', OWNER, '--generation', generation], comments(list));
}

describe('classify', () => {
  it('calls the active coordinator’s own marker a coordinator reply', () => {
    expect(classify('🤖 **Coordinator v2:** cycle report, nothing blocked.')).toBe('coordinator');
  });

  it('does NOT call an implementation agent’s 🤖 post a coordinator reply', () => {
    // The live regression: this comment buried three operator directives.
    expect(classify('🤖 **Agent (release v1.13.0):** Release complete.')).toBe('machine');
  });

  it('does NOT count another generation’s coordinator marker as this one’s reply', () => {
    expect(classify('🤖 **Coordinator v1:** handoff.', 'v2')).toBe('machine');
  });

  it('treats the heartbeat as machine noise, not an operator message', () => {
    // It starts with an HTML comment, so a `startswith("🤖")` test put it in
    // the OPERATOR bucket and a freshly rotated channel reported its own
    // heartbeat as an unanswered operator message.
    const hb = '<!-- coord-heartbeat -->\n🤖 **Coordinator v2:** heartbeat — last cycle …';
    expect(classify(hb)).toBe('heartbeat');
  });

  it('treats reviewer, deadman and read-receipt markers as machine noise', () => {
    expect(classify('🔎 **Adversarial review:** …')).toBe('machine');
    expect(classify('⏱️ **Deadman:** no heartbeat …')).toBe('machine');
    expect(classify('⏱ **Deadman:** no variation selector …')).toBe('machine');
    expect(classify('👀 read')).toBe('machine');
  });

  it('tolerates leading whitespace before a marker', () => {
    expect(classify('   🤖 **Coordinator v2:** indented')).toBe('coordinator');
  });

  it('calls anything else an operator message', () => {
    expect(classify('Why is nothing in progress again?')).toBe('operator');
  });

  it('with no known generation, calls even a coordinator marker machine — never a reply', () => {
    // Bias: a false alarm is cheap, a dropped operator message is not.
    expect(classify('🤖 **Coordinator v2:** …', '')).toBe('machine');
  });
});

describe('unanswered', () => {
  it('reports operator comments after the coordinator’s last reply', () => {
    const out = unanswered([
      { id: 1, body: 'old ask, already handled' },
      { id: 2, body: '🤖 **Coordinator v2:** handled it.' },
      { id: 3, body: 'Why is nothing in progress again?' },
    ]);
    expect(out).not.toContain('old ask');
    expect(out).toContain('Why is nothing in progress again?');
  });

  it('does NOT let an agent post bury unanswered operator messages', () => {
    // The exact live sequence from the review.
    const out = unanswered([
      { id: 1, body: 'Check the comments for the PR related to comma in a sub…' },
      { id: 2, body: 'Why is nothing in progress again?' },
      { id: 3, body: 'The subagents need to be addressing the PR comments.' },
      { id: 4, body: '🤖 **Agent (release v1.13.0):** Release complete.' },
    ]);
    expect(out).toContain('Check the comments');
    expect(out).toContain('Why is nothing in progress');
    expect(out).toContain('The subagents need');
  });

  it('reports nothing on a freshly rotated channel that has only a heartbeat', () => {
    const out = unanswered([
      { id: 1, body: '<!-- coord-heartbeat -->\n🤖 **Coordinator v3:** heartbeat', },
    ], 'v3');
    expect(out.trim()).toBe('');
  });

  it('ignores comments from anyone who is not the repo owner', () => {
    const out = unanswered([
      { id: 1, body: 'drive-by from a stranger', login: 'someone-else', association: 'NONE' },
    ]);
    expect(out.trim()).toBe('');
  });

  it('orders the cutoff by comment id, so an edited-into-🤖 comment cannot hide a later ask', () => {
    // created_at ordering was the old cutoff key; a comment edited into 🤖
    // form keeps its original created_at and would rewind the cutoff.
    const out = unanswered([
      { id: 10, body: '🤖 **Coordinator v2:** replied.' },
      { id: 11, body: 'a later ask' },
    ]);
    expect(out).toContain('a later ask');
  });

  it('flattens the array-of-pages shape that `gh api --paginate --slurp` returns', () => {
    // --paginate --jq evaluated the filter once PER PAGE, so past 100 comments
    // the cutoff was re-derived per page and answered messages resurfaced.
    const page1 = JSON.parse(comments([{ id: 1, body: 'early ask' }]));
    const page2 = JSON.parse(comments([
      { id: 2, body: '🤖 **Coordinator v2:** replied.' },
      { id: 3, body: 'late ask' },
    ]));
    const out = run(
      ['unanswered', '--owner', OWNER, '--generation', 'v2'],
      JSON.stringify([page1, page2])
    );
    expect(out).not.toContain('early ask');
    expect(out).toContain('late ask');
  });

  it('refuses to report "no unanswered messages" when the fetch produced nothing', () => {
    // The worst possible lie this tool can tell. An empty inbox and a failed
    // API call rendered identically — silence read as "you are all caught up".
    const r = spawnSync(process.execPath, [SCRIPT, 'unanswered', '--owner', OWNER, '--generation', 'v2'], {
      input: '',
      encoding: 'utf8',
    });
    expect(`${r.stdout}${r.stderr}`).toContain('NO DATA');
    expect(r.status).not.toBe(0);
  });

  it('accepts a genuinely empty thread without complaining', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'unanswered', '--owner', OWNER, '--generation', 'v2'], {
      input: '[]',
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('shows only the first line of a multi-line ask, never a byte slice', () => {
    const out = unanswered([{ id: 1, body: 'first line\nsecond line' }]);
    expect(out).toContain('first line');
    expect(out).not.toContain('second line');
  });
});

describe('inbox', () => {
  function inbox(nodes: { number: number; lastBody?: string; labels?: string[] }[], args: string[] = []) {
    const mk = (n: (typeof nodes)[number]) => ({
      number: n.number,
      title: `thread ${n.number}`,
      updatedAt: '2026-08-02T00:00:00Z',
      labels: { nodes: (n.labels ?? []).map((name) => ({ name })) },
      comments: {
        nodes:
          n.lastBody === undefined
            ? []
            : [{ createdAt: '2026-08-02T00:00:00Z', url: 'https://example.invalid/c', body: n.lastBody }],
      },
    });
    const payload = {
      data: {
        repository: {
          issues: { nodes: nodes.map(mk) },
          pullRequests: { nodes: [] },
        },
      },
    };
    return run(['inbox', '--generation', 'v2', ...args], JSON.stringify(payload));
  }

  it('flags a thread whose last word is the operator’s', () => {
    const out = inbox([{ number: 5, lastBody: 'please look at this' }]);
    expect(out).toContain('#5');
    expect(out).toContain('●');
  });

  it('does not flag a thread an agent answered', () => {
    const out = inbox([{ number: 6, lastBody: '🤖 **Agent (fix #6):** pushed a fix.' }]);
    expect(out).not.toContain('#6');
  });

  it('does not flag the coordinator channel just because its last comment is a heartbeat', () => {
    // Same classifier as `unanswered`: the two must agree.
    const out = inbox([
      { number: 7, lastBody: '<!-- coord-heartbeat -->\n🤖 **Coordinator v2:** heartbeat', labels: ['coordinator-active'] },
    ]);
    expect(out).not.toContain('#7');
  });

  it('flags an untouched, unlabeled thread with no comments at all', () => {
    const out = inbox([{ number: 8 }]);
    expect(out).toContain('#8');
  });

  it('--all includes threads that were already answered', () => {
    const out = inbox([{ number: 9, lastBody: '🤖 **Agent (x):** done.' }], ['--all']);
    expect(out).toContain('#9');
  });
});
