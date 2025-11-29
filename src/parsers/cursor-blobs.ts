import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

// Cache the SQL.js initialization
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

// Cursor stores conversations in SQLite with blob storage
export interface CursorMeta {
  agentId: string;
  latestRootBlobId: string;
  name: string;
  mode: string;
  createdAt: number;
  lastUsedModel: string;
}

export interface CursorMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  id: string;
  content: CursorContent[];
}

export interface CursorContent {
  type: 'text' | 'tool-call' | 'tool-result';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  toolUseId?: string;
  content?: CursorContent[];
}

export interface ParsedCursorSession {
  conversationId: string;
  workspaceHash: string;
  storePath: string;
  title: string;
  createdAt: Date;
  lastUsedModel: string;
  messages: ParsedCursorMessage[];
}

export interface ParsedCursorMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  contentText: string;
  contentJson?: object;
  toolName?: string;
  toolInput?: object;
  timestamp?: Date;
  sequenceNum: number;
}

// Helper to parse and validate timestamps
function parseTimestamp(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  const date = new Date(timestamp as string | number);
  if (isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < 2020 || year > 2030) return null;
  return date;
}

// Decode hex-encoded JSON from meta table
function decodeHexJson(hexValue: string): unknown {
  try {
    const decoded = Buffer.from(hexValue, 'hex').toString('utf8');
    return JSON.parse(decoded);
  } catch {
    // Try direct JSON parse
    try {
      return JSON.parse(hexValue);
    } catch {
      return null;
    }
  }
}

// Extract text from Cursor content array
function extractCursorText(content: CursorContent[]): string {
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

// Extract tool usage from content
function extractCursorTool(content: CursorContent[]): { name: string; input: object } | undefined {
  const toolCall = content.find((c) => c.type === 'tool-call');
  if (toolCall && toolCall.toolName) {
    return { name: toolCall.toolName, input: toolCall.args ?? {} };
  }
  return undefined;
}

// Parse a single Cursor store.db
export async function parseCursorStoreDb(storePath: string): Promise<ParsedCursorSession | null> {
  const pathParts = storePath.split('/');
  const conversationId = pathParts[pathParts.length - 2]; // UUID directory
  const workspaceHash = pathParts[pathParts.length - 3]; // Workspace hash directory

  let db: SqlJsDatabase | null = null;

  try {
    const SQL = await getSqlJs();
    const fileBuffer = await readFile(storePath);
    db = new SQL.Database(fileBuffer);

    // Get metadata from meta table
    const metaResult = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaResult.length || !metaResult[0].values.length) {
      return null;
    }

    const metaValue = metaResult[0].values[0][0] as string;
    const meta = decodeHexJson(metaValue) as CursorMeta | null;
    if (!meta) {
      return null;
    }

    // Get all blobs
    const blobsResult = db.exec('SELECT id, data FROM blobs');
    if (!blobsResult.length) {
      return null;
    }

    const messages: ParsedCursorMessage[] = [];
    let sequenceNum = 0;

    for (const row of blobsResult[0].values) {
      try {
        const blobId = row[0] as string;
        const blobData = row[1] as Uint8Array;
        const text = Buffer.from(blobData).toString('utf8');
        const parsed = JSON.parse(text) as CursorMessage;

        // Only process message objects
        if (parsed.role && parsed.content && Array.isArray(parsed.content)) {
          const toolUsage = extractCursorTool(parsed.content);

          messages.push({
            id: blobId,
            role: toolUsage ? 'tool' : parsed.role,
            contentText: extractCursorText(parsed.content),
            contentJson: parsed,
            toolName: toolUsage?.name,
            toolInput: toolUsage?.input,
            sequenceNum: sequenceNum++,
          });
        }
      } catch {
        // Not a JSON blob, skip
      }
    }

    if (messages.length === 0) {
      return null;
    }

    const createdAt = parseTimestamp(meta.createdAt);
    if (!createdAt) {
      console.warn(`Invalid createdAt timestamp for Cursor session: ${storePath}`);
      return null;
    }

    return {
      conversationId,
      workspaceHash,
      storePath,
      title: meta.name || 'Untitled',
      createdAt,
      lastUsedModel: meta.lastUsedModel || 'unknown',
      messages,
    };
  } catch (e) {
    console.warn(`Failed to parse Cursor store: ${storePath}`, e);
    return null;
  } finally {
    db?.close();
  }
}

// Discover all Cursor conversation store.db files
export async function discoverCursorStores(basePath: string): Promise<string[]> {
  const stores: string[] = [];

  try {
    const workspaces = await readdir(basePath);

    for (const workspace of workspaces) {
      const workspacePath = join(basePath, workspace);
      const workspaceStat = await stat(workspacePath);

      if (!workspaceStat.isDirectory()) continue;

      try {
        const conversations = await readdir(workspacePath);

        for (const conversation of conversations) {
          const storePath = join(workspacePath, conversation, 'store.db');

          try {
            const storeStat = await stat(storePath);
            if (storeStat.isFile()) {
              stores.push(storePath);
            }
          } catch {
            // store.db doesn't exist
          }
        }
      } catch {
        // Can't read workspace directory
      }
    }
  } catch (e) {
    console.error(`Failed to discover Cursor stores in ${basePath}:`, e);
  }

  return stores;
}
