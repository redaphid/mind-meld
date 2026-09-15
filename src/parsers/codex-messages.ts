import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { normalizeDeep } from '../utils/text-encoding.js';
import { stripScaffolding } from '../utils/strip-scaffolding.js';
import type { BadLine, ParsedLine, ParsedMessage, ParsedSession } from './claude-messages.js';

type CodexRecord = {
  type?: string;
  timestamp?: string;
  ordinal?: number;
  payload?: Record<string, unknown>;
};

const parseTimestamp = (value: unknown): Date | null => {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
};

const jsonObject = (value: unknown): object | undefined => {
  if (value && typeof value === 'object') return value as object;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as object) : { value: parsed };
  } catch {
    return { value };
  }
};

const textValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
};

// Codex writes host-provided context as user content before the actual user
// turn. These blocks are transport metadata, not conversation. Remove only
// complete, known wrappers at the edges so user-authored XML remains intact.
const CODEX_CONTEXT_BLOCK = /^\s*<(recommended_plugins|environment_context|permissions instructions)>[\s\S]*?<\/\1>\s*/;
export const stripCodexContext = (text: string): string => {
  let result = text;
  while (CODEX_CONTEXT_BLOCK.test(result)) result = result.replace(CODEX_CONTEXT_BLOCK, '');
  return stripScaffolding(result).trim();
};

const contentText = (content: unknown, role: string): string => {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      if (item.type !== 'input_text' && item.type !== 'output_text') return '';
      return textValue(item.text);
    })
    .map((text) => (role === 'user' ? stripCodexContext(text) : text))
    .filter(Boolean)
    .join('\n');
};

export function parseCodexLine(line: string, sequenceNum: number): ParsedLine {
  const record = normalizeDeep(JSON.parse(line)) as CodexRecord;
  const payload = record.payload ?? {};
  if (record.type !== 'response_item')
    return { kind: 'skip', reason: `not a response item (type: ${record.type})` };

  const timestamp = parseTimestamp(record.timestamp);
  if (!timestamp) return { kind: 'skip', reason: `invalid timestamp: ${record.timestamp}` };

  const payloadType = String(payload.type ?? '');
  const externalId = String(payload.id ?? payload.call_id ?? `ordinal:${record.ordinal ?? sequenceNum}`);
  let message: ParsedMessage | null = null;

  if (payloadType === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const text = contentText(payload.content, payload.role);
    if (!text) return { kind: 'skip', reason: 'empty or context-only message' };
    message = {
      uuid: externalId,
      parentUuid: null,
      role: payload.role,
      contentText: text,
      contentJson: payload,
      timestamp,
      sequenceNum,
      isSidechain: false,
    };
  } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    message = {
      uuid: externalId,
      parentUuid: null,
      role: 'tool',
      contentText: '',
      contentJson: payload,
      toolName: String(payload.name ?? 'tool'),
      toolInput: jsonObject(payload.arguments ?? payload.input) ?? {},
      timestamp,
      sequenceNum,
      isSidechain: false,
    };
  } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const output = textValue(payload.output);
    message = {
      uuid: externalId,
      parentUuid: null,
      role: 'tool',
      contentText: output,
      contentJson: payload,
      toolResult: output,
      timestamp,
      sequenceNum,
      isSidechain: false,
    };
  }

  if (!message) return { kind: 'skip', reason: `unsupported response item: ${payloadType}` };
  return {
    kind: 'message',
    metadata: { inputTokens: 0, outputTokens: 0 },
    message,
  };
}

type SessionMeta = {
  id?: string;
  session_id?: string;
  cwd?: string;
  cli_version?: string;
  thread_source?: string;
  source?: unknown;
};

const subagentMetadata = (meta: SessionMeta): { isAgent: boolean; parentSessionId?: string; agentId?: string } => {
  const source = meta.source && typeof meta.source === 'object'
    ? (meta.source as { subagent?: unknown }).subagent
    : undefined;
  const details = source && typeof source === 'object' ? source as Record<string, unknown> : undefined;
  const spawn = details?.thread_spawn && typeof details.thread_spawn === 'object'
    ? details.thread_spawn as Record<string, unknown>
    : undefined;
  const isAgent = meta.thread_source === 'subagent' || source !== undefined;
  return {
    isAgent,
    parentSessionId: typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : undefined,
    agentId: typeof spawn?.agent_path === 'string'
      ? spawn.agent_path
      : typeof details?.other === 'string' ? details.other : undefined,
  };
};

export async function parseCodexSessionFile(filePath: string): Promise<ParsedSession | null> {
  const fileStats = await stat(filePath);
  const messages: ParsedMessage[] = [];
  const badLines: BadLine[] = [];
  const lineNumbers = new Map<string, number>();
  let meta: SessionMeta = {};
  let modelUsed: string | undefined;
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;
  let lineNumber = 0;

  const input = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of input) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const raw = normalizeDeep(JSON.parse(line)) as CodexRecord;
      if (raw.type === 'session_meta') meta = raw.payload as SessionMeta;
      if (raw.type === 'turn_context' && typeof raw.payload?.model === 'string') modelUsed ??= raw.payload.model;
      const parsed = parseCodexLine(line, messages.length);
      if (parsed.kind !== 'message') continue;
      messages.push(parsed.message);
      lineNumbers.set(parsed.message.uuid, lineNumber);
      firstTimestamp ??= parsed.message.timestamp;
      lastTimestamp = parsed.message.timestamp;
    } catch (error) {
      badLines.push({
        lineNumber,
        raw: line,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sessionId = meta.id ?? meta.session_id ?? basename(filePath, '.jsonl').replace(/^rollout-[^-]+-[^-]+-/, '');
  if (!sessionId) return null;
  const agent = subagentMetadata(meta);
  return {
    sessionId,
    parentSessionId: agent.parentSessionId,
    filePath,
    fileModifiedAt: fileStats.mtime,
    isAgent: agent.isAgent,
    agentId: agent.agentId,
    messages,
    firstTimestamp,
    lastTimestamp,
    cwd: meta.cwd,
    claudeVersion: meta.cli_version,
    modelUsed,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    badLines,
    lineNumbers,
  };
}
