import { createReadStream } from 'fs';
import { createInterface } from 'node:readline';
import { stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { normalizeDeep } from '../utils/text-encoding.js';
import { stripScaffolding } from '../utils/strip-scaffolding.js';

// Types matching Claude Code JSONL format
export interface ClaudeMessage {
  type: 'user' | 'assistant' | 'file-history-snapshot';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  agentId?: string;
  userType?: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | AssistantContent[];
    model?: string;
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  todos?: Todo[];
  thinkingMetadata?: {
    level: string;
    disabled: boolean;
  };
  requestId?: string;
  snapshot?: unknown;
  isSnapshotUpdate?: boolean;
  messageId?: string;
}

export interface AssistantContent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface Todo {
  content: string;
  status: string;
  activeForm?: string;
  id?: string;
}

// Helper to parse and validate timestamps
function parseTimestamp(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  const date = new Date(timestamp as string | number);
  // Check if valid date (not NaN and within reasonable range)
  if (isNaN(date.getTime())) return null;
  // Sanity check: should be between 2020 and 2030
  const year = date.getFullYear();
  if (year < 2020 || year > 2030) return null;
  return date;
}

export interface ParsedSession {
  sessionId: string;
  parentSessionId?: string; // For agent files, this is the parent conversation's sessionId
  filePath: string;
  fileModifiedAt: Date;
  isAgent: boolean;
  agentId?: string;
  messages: ParsedMessage[];
  firstTimestamp?: Date;
  lastTimestamp?: Date;
  cwd?: string;
  gitBranch?: string;
  claudeVersion?: string;
  modelUsed?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  // Lines this parser could not read. Never empty-by-omission: the caller is
  // expected to quarantine them.
  badLines: BadLine[];
  // uuid → source line number, for pinning a failed insert to the file.
  lineNumbers: Map<string, number>;
}

export interface ParsedMessage {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  contentText: string;
  contentJson?: object;
  toolName?: string;
  toolInput?: object;
  thinkingText?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  timestamp: Date;
  sequenceNum: number;
  isSidechain: boolean;
}

// Extract text content from message.
//
// Scaffolding is removed here, at the parse boundary, so that the stored
// content_text is what a human actually typed — nothing downstream has to know
// that slash-command XML or hook-injected reminders ever existed (issue #37).
//
// This supersedes an earlier pattern that matched only four *named* hook
// varieties of <system-reminder>; generic ones were left in and embedded.
function extractTextContent(message: ClaudeMessage): string {
  if (!message.message) return '';

  const content = message.message.content;
  if (typeof content === 'string') return stripScaffolding(content);

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        parts.push(c.text);
      } else if (c.type === 'tool_result') {
        const resultContent = (c as { content?: string | object[] }).content;
        if (typeof resultContent === 'string') {
          parts.push(resultContent);
        } else if (Array.isArray(resultContent)) {
          for (const rc of resultContent) {
            if (typeof rc === 'object' && 'text' in rc && typeof rc.text === 'string') {
              parts.push(rc.text);
            }
          }
        }
      }
    }
    return stripScaffolding(parts.join('\n'));
  }

  return '';
}

// Extract thinking content
function extractThinkingContent(message: ClaudeMessage): string | undefined {
  if (!message.message || typeof message.message.content === 'string') return undefined;

  const content = message.message.content;
  if (!Array.isArray(content)) return undefined;

  const thinking = content
    .filter((c): c is AssistantContent => c.type === 'thinking')
    .map((c) => c.thinking ?? '')
    .join('\n');

  return thinking || undefined;
}

// Extract tool usage
function extractToolUsage(message: ClaudeMessage): { name: string; input: object } | undefined {
  if (!message.message || typeof message.message.content === 'string') return undefined;

  const content = message.message.content;
  if (!Array.isArray(content)) return undefined;

  const toolUse = content.find((c): c is AssistantContent => c.type === 'tool_use');
  if (toolUse && toolUse.name) {
    return { name: toolUse.name, input: toolUse.input ?? {} };
  }

  return undefined;
}

// Metadata a line contributes to its session. Collected as the file is walked;
// the first non-empty value of each wins.
export interface LineMetadata {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  claudeVersion?: string;
  modelUsed?: string;
  inputTokens: number;
  outputTokens: number;
}

export type ParsedLine =
  | { kind: 'message'; message: ParsedMessage; metadata: LineMetadata }
  // A line that carries no message — session metadata, a file snapshot, an
  // unusable timestamp. Skipping is correct and is not a failure.
  | { kind: 'skip'; reason: string };

// A line that could not be read at all. The raw text is kept so the record can
// be quarantined and replayed rather than dropped.
export interface BadLine {
  lineNumber: number;
  raw: string;
  error: string;
}

// One JSONL line → one message, in isolation. Pulled out of the file walk so
// that the exact same code can replay a single quarantined record later; a
// record that failed once must not take a second, different path back in.
export function parseClaudeLine(line: string, sequenceNum: number): ParsedLine {
  // Normalized the moment it becomes structured data: transcripts of Windows
  // tool output carry escaped-NUL UTF-16LE runs that JSON.parse turns into
  // real U+0000 characters. Removing the NULs recovers the readable text of
  // such a run (that is all the decode there is — see text-encoding.ts), and
  // lone surrogates are dropped, before anything downstream stores, embeds,
  // or searches the content.
  const parsed = normalizeDeep(JSON.parse(line)) as ClaudeMessage;

  if (!['user', 'assistant'].includes(parsed.type))
    return { kind: 'skip', reason: `not a message (type: ${parsed.type})` };

  const timestamp = parseTimestamp(parsed.timestamp);
  if (!timestamp) return { kind: 'skip', reason: `invalid timestamp: ${parsed.timestamp}` };

  const toolUsage = extractToolUsage(parsed);

  return {
    kind: 'message',
    metadata: {
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      gitBranch: parsed.gitBranch,
      claudeVersion: parsed.version,
      modelUsed: parsed.type === 'assistant' ? parsed.message?.model : undefined,
      inputTokens: parsed.message?.usage?.input_tokens ?? 0,
      outputTokens: parsed.message?.usage?.output_tokens ?? 0,
    },
    message: {
      uuid: parsed.uuid,
      parentUuid: parsed.parentUuid,
      role: parsed.type === 'user' ? 'user' : toolUsage ? 'tool' : 'assistant',
      contentText: extractTextContent(parsed),
      contentJson: parsed.message,
      toolName: toolUsage?.name,
      toolInput: toolUsage?.input,
      thinkingText: extractThinkingContent(parsed),
      model: parsed.message?.model,
      inputTokens: parsed.message?.usage?.input_tokens,
      outputTokens: parsed.message?.usage?.output_tokens,
      cacheCreationTokens: parsed.message?.usage?.cache_creation_input_tokens,
      cacheReadTokens: parsed.message?.usage?.cache_read_input_tokens,
      timestamp,
      sequenceNum,
      isSidechain: parsed.isSidechain ?? false,
    },
  };
}

// Parse a single JSONL file
export async function parseClaudeSessionFile(filePath: string): Promise<ParsedSession | null> {
  const fileStats = await stat(filePath);
  const fileName = basename(filePath, '.jsonl');

  // Determine if this is an agent file
  const isAgent = fileName.startsWith('agent-');
  const agentId = isAgent ? fileName.replace('agent-', '') : undefined;
  const sessionId = isAgent ? fileName : fileName;

  const messages: ParsedMessage[] = [];
  const badLines: BadLine[] = [];
  // uuid → the line it came from, so a message that fails to insert can point at
  // its exact place in the source file.
  const lineNumbers = new Map<string, number>();
  let sequenceNum = 0;
  let sessionIdFromContent: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let claudeVersion: string | undefined;
  let modelUsed: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    try {
      const result = parseClaudeLine(line, sequenceNum);
      if (result.kind === 'skip') {
        // Only an unusable timestamp is worth reporting; metadata lines are
        // skipped by the thousand and are entirely normal.
        if (result.reason.startsWith('invalid timestamp'))
          console.warn(`Skipping message in ${filePath}: ${result.reason}`);
        continue;
      }

      const { message, metadata } = result;
      sessionIdFromContent ??= metadata.sessionId;
      cwd ??= metadata.cwd;
      gitBranch ??= metadata.gitBranch;
      claudeVersion ??= metadata.claudeVersion;
      modelUsed ??= metadata.modelUsed;
      totalInputTokens += metadata.inputTokens;
      totalOutputTokens += metadata.outputTokens;

      sequenceNum++;
      messages.push(message);
      lineNumbers.set(message.uuid, lineNumber);
    } catch (e) {
      // Kept, not dropped: the raw line goes to the caller, which quarantines it
      // so a line this parser cannot read is still recoverable later.
      badLines.push({
        lineNumber,
        raw: line,
        error: e instanceof Error ? e.message : String(e),
      });
      console.warn(`Failed to parse line ${lineNumber} in ${filePath}:`, e);
    }
  }

  // A file whose every line failed still has to report those failures, so the
  // caller can quarantine them — returning null would lose them silently.
  if (messages.length === 0 && badLines.length === 0) return null;

  // Sort by timestamp
  messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Re-assign sequence numbers after sort
  messages.forEach((m, i) => (m.sequenceNum = i));

  // For agent files: use filename as sessionId, sessionIdFromContent as parentSessionId
  // For regular files: use sessionIdFromContent if available, otherwise filename
  const finalSessionId = isAgent ? sessionId : (sessionIdFromContent ?? sessionId);
  const parentSessionId = isAgent ? sessionIdFromContent : undefined;

  return {
    sessionId: finalSessionId,
    parentSessionId,
    filePath,
    fileModifiedAt: fileStats.mtime,
    isAgent,
    agentId,
    messages,
    firstTimestamp: messages[0]?.timestamp,
    lastTimestamp: messages[messages.length - 1]?.timestamp,
    cwd,
    gitBranch,
    claudeVersion,
    modelUsed,
    totalInputTokens,
    totalOutputTokens,
    badLines,
    lineNumbers,
  };
}

// Decode project path from encoded directory name
export function decodeProjectPath(encodedName: string): string {
  // Convert "-Users-you-Projects-acme" to "/Users/you/Projects/acme"
  if (encodedName.startsWith('-')) {
    return encodedName.replace(/^-/, '/').replace(/-/g, '/');
  }
  return encodedName;
}

// Extract project name from path
export function extractProjectName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// Parse history.jsonl
export interface HistoryEntry {
  display: string;
  timestamp: Date;
  project: string;
  pastedContents?: Record<string, unknown>;
}

// History entries are convenience data (the prompt-history picker), so a line
// this parser cannot read is counted rather than quarantined — but it is never
// silent: the caller gets the counts and is expected to surface them.
export interface ParsedHistory {
  entries: HistoryEntry[];
  // Lines that were not valid JSON.
  malformedLines: number;
  // Lines that parsed but carried no usable timestamp.
  invalidTimestamps: number;
}

export async function parseHistoryFile(historyPath: string): Promise<ParsedHistory> {
  const entries: HistoryEntry[] = [];
  let malformedLines = 0;
  let invalidTimestamps = 0;

  const fileStream = createReadStream(historyPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = normalizeDeep(JSON.parse(line)) as {
        display: string;
        timestamp: number;
        project: string;
        pastedContents?: Record<string, unknown>;
      };

      const timestamp = parseTimestamp(parsed.timestamp);
      if (!timestamp) {
        invalidTimestamps++;
        continue;
      }

      entries.push({
        display: parsed.display,
        timestamp,
        project: parsed.project,
        pastedContents: parsed.pastedContents,
      });
    } catch {
      malformedLines++;
    }
  }

  return { entries, malformedLines, invalidTimestamps };
}
