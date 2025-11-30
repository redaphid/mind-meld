import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { stat } from 'fs/promises';
import { basename, dirname, join } from 'path';

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

// Extract text content from message
function extractTextContent(message: ClaudeMessage): string {
  if (!message.message) return '';

  const content = message.message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        parts.push(c.text);
      } else if (c.type === 'tool_result') {
        // Extract text from tool_result content
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
    return parts.join('\n');
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

// Parse a single JSONL file
export async function parseClaudeSessionFile(filePath: string): Promise<ParsedSession | null> {
  const fileStats = await stat(filePath);
  const fileName = basename(filePath, '.jsonl');

  // Determine if this is an agent file
  const isAgent = fileName.startsWith('agent-');
  const agentId = isAgent ? fileName.replace('agent-', '') : undefined;
  const sessionId = isAgent ? fileName : fileName;

  const messages: ParsedMessage[] = [];
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

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as ClaudeMessage;

      // Skip non-message entries (metadata types)
      const messageTypes = ['user', 'assistant'];
      if (!messageTypes.includes(parsed.type)) continue;

      // Extract session metadata from first message
      if (!sessionIdFromContent && parsed.sessionId) {
        sessionIdFromContent = parsed.sessionId;
      }
      if (!cwd && parsed.cwd) cwd = parsed.cwd;
      if (!gitBranch && parsed.gitBranch) gitBranch = parsed.gitBranch;
      if (!claudeVersion && parsed.version) claudeVersion = parsed.version;

      // Extract model from assistant messages
      if (parsed.type === 'assistant' && parsed.message?.model && !modelUsed) {
        modelUsed = parsed.message.model;
      }

      // Extract tokens
      if (parsed.message?.usage) {
        totalInputTokens += parsed.message.usage.input_tokens ?? 0;
        totalOutputTokens += parsed.message.usage.output_tokens ?? 0;
      }

      const toolUsage = extractToolUsage(parsed);

      // Validate timestamp - skip messages with invalid timestamps
      const timestamp = parseTimestamp(parsed.timestamp);
      if (!timestamp) {
        console.warn(`Skipping message with invalid timestamp in ${filePath}: ${parsed.timestamp}`);
        continue;
      }

      const parsedMessage: ParsedMessage = {
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
        sequenceNum: sequenceNum++,
        isSidechain: parsed.isSidechain ?? false,
      };

      messages.push(parsedMessage);
    } catch (e) {
      // Skip malformed lines
      console.warn(`Failed to parse line in ${filePath}:`, e);
    }
  }

  if (messages.length === 0) return null;

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
  };
}

// Decode project path from encoded directory name
export function decodeProjectPath(encodedName: string): string {
  // Convert "-Users-hypnodroid-Projects-sibi" to "/Users/hypnodroid/Projects/sibi"
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

export async function parseHistoryFile(historyPath: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];

  const fileStream = createReadStream(historyPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as {
        display: string;
        timestamp: number;
        project: string;
        pastedContents?: Record<string, unknown>;
      };

      const timestamp = parseTimestamp(parsed.timestamp);
      if (!timestamp) continue;

      entries.push({
        display: parsed.display,
        timestamp,
        project: parsed.project,
        pastedContents: parsed.pastedContents,
      });
    } catch (e) {
      // Skip malformed lines
    }
  }

  return entries;
}
