import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexLine, parseCodexSessionFile, stripCodexContext } from './codex-messages.js';

const dirs: string[] = [];
const record = (type: string, payload: object, ordinal: number) => JSON.stringify({
  type,
  payload,
  ordinal,
  timestamp: `2026-01-01T00:00:0${ordinal}Z`,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseCodexLine', () => {
  it('keeps user and assistant text but skips developer instructions', () => {
    const user = parseCodexLine(record('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser' }],
    }, 1), 0);
    expect(user.kind).toBe('message');
    if (user.kind === 'message') expect(user.message.contentText).toBe('Fix the parser');

    expect(parseCodexLine(record('response_item', {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden' }],
    }, 2), 1).kind).toBe('skip');
  });

  it('maps calls and outputs to tool messages without truncating them', () => {
    const call = parseCodexLine(record('response_item', {
      type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"/home/test/a"}',
    }, 1), 0);
    expect(call.kind).toBe('message');
    if (call.kind === 'message') {
      expect(call.message.toolName).toBe('read_file');
      expect(call.message.toolInput).toEqual({ path: '/home/test/a' });
    }

    const output = parseCodexLine(record('response_item', {
      type: 'function_call_output', call_id: 'call-1-output', output: 'all output',
    }, 2), 1);
    expect(output.kind).toBe('message');
    if (output.kind === 'message') expect(output.message.toolResult).toBe('all output');
  });

  it('handles custom calls, structured values, and stable fallback ids', () => {
    const custom = parseCodexLine(record('response_item', {
      type: 'custom_tool_call', input: { query: 'x' }, name: 'search',
    }, 3), 9);
    expect(custom.kind).toBe('message');
    if (custom.kind === 'message') {
      expect(custom.message.uuid).toBe('ordinal:3');
      expect(custom.message.toolInput).toEqual({ query: 'x' });
    }

    const scalar = parseCodexLine(record('response_item', {
      type: 'function_call', arguments: '42', name: 'answer',
    }, 4), 10);
    if (scalar.kind === 'message') expect(scalar.message.toolInput).toEqual({ value: 42 });

    const malformed = parseCodexLine(record('response_item', {
      type: 'function_call', arguments: 'not json', name: 'raw',
    }, 5), 11);
    if (malformed.kind === 'message') expect(malformed.message.toolInput).toEqual({ value: 'not json' });

    const structuredOutput = parseCodexLine(record('response_item', {
      type: 'custom_tool_call_output', output: { ok: true }, id: 'out-1',
    }, 6), 12);
    if (structuredOutput.kind === 'message') expect(structuredOutput.message.contentText).toBe('{"ok":true}');

    const sequenceFallback = parseCodexLine(JSON.stringify({
      type: 'response_item', timestamp: '2026-01-01T00:00:00Z',
      payload: { type: 'custom_tool_call', name: 'noop' },
    }), 13);
    if (sequenceFallback.kind === 'message') expect(sequenceFallback.message.uuid).toBe('ordinal:13');
  });

  it('skips records that are not indexable conversation messages', () => {
    expect(parseCodexLine(record('event_msg', { type: 'task_started' }, 1), 0).kind).toBe('skip');
    expect(parseCodexLine(JSON.stringify({
      type: 'response_item', timestamp: 'not-a-date', payload: { type: 'message', role: 'user' },
    }), 0).kind).toBe('skip');
    expect(parseCodexLine(record('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: null }],
    }, 2), 0).kind).toBe('skip');
    expect(parseCodexLine(record('response_item', { type: 'reasoning' }, 3), 0).kind).toBe('skip');
    expect(parseCodexLine(JSON.stringify({
      type: 'response_item', timestamp: '2026-01-01T00:00:00Z',
    }), 7).kind).toBe('skip');
  });

  it('accepts assistant output and ignores unknown content parts', () => {
    const parsed = parseCodexLine(record('response_item', {
      type: 'message', role: 'assistant', content: [null, 'bad', { type: 'image' }, { type: 'output_text', text: 'done' }],
    }, 1), 0);
    expect(parsed.kind).toBe('message');
    if (parsed.kind === 'message') expect(parsed.message.contentText).toBe('done');
  });
});

it('removes only known Codex context wrappers', () => {
  expect(stripCodexContext('<environment_context>generated</environment_context>\nreal')).toBe('real');
  expect(stripCodexContext('<example>user-authored</example>')).toBe('<example>user-authored</example>');
});

it('removes consecutive context wrappers and preserves ordinary text unchanged', () => {
  expect(stripCodexContext(
    '<recommended_plugins>x</recommended_plugins>\n<permissions instructions>y</permissions instructions>\nquestion'
  )).toBe('question');
  expect(stripCodexContext('plain question')).toBe('plain question');
});

it('reads session metadata and links spawned subagents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-parser-'));
  dirs.push(dir);
  const file = join(dir, 'rollout-test.jsonl');
  await writeFile(file, [
    record('session_meta', {
      id: 'child-id', cwd: '/home/test/project', cli_version: '1.2.3', thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-id', agent_path: '/root/worker' } } },
    }, 0),
    record('turn_context', { model: 'test-model' }, 1),
    record('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }],
    }, 2),
    '{bad json',
  ].join('\n'));

  const session = await parseCodexSessionFile(file);
  expect(session).toMatchObject({
    sessionId: 'child-id', parentSessionId: 'parent-id', isAgent: true,
    agentId: '/root/worker', cwd: '/home/test/project', claudeVersion: '1.2.3', modelUsed: 'test-model',
  });
  expect(session?.messages).toHaveLength(1);
  expect(session?.badLines).toHaveLength(1);
});

it('supports guardian agents and a filename-derived session id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-parser-'));
  dirs.push(dir);
  const file = join(dir, 'fallback.jsonl');
  await writeFile(file, [
    '',
    record('session_meta', { cwd: '/home/test/project', source: { subagent: { other: 'guardian' } } }, 0),
    record('turn_context', { model: 123 }, 1),
    record('response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checked' }],
    }, 2),
  ].join('\n'));
  expect(await parseCodexSessionFile(file)).toMatchObject({
    sessionId: 'fallback', isAgent: true, agentId: 'guardian', modelUsed: undefined,
  });
});

it('tolerates partial legacy subagent metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-parser-'));
  dirs.push(dir);
  const file = join(dir, 'legacy.jsonl');
  await writeFile(file, [
    record('session_meta', {
      id: 'legacy', source: { subagent: { thread_spawn: 'unknown', other: 123 } },
    }, 0),
    record('response_item', {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }],
    }, 1),
  ].join('\n'));
  expect(await parseCodexSessionFile(file)).toMatchObject({
    isAgent: true, parentSessionId: undefined, agentId: undefined,
  });
});
