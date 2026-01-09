import { setDatabasePath, listConversations, listMessages } from '@hypnodroid/cursor-conversations';
import { homedir } from 'os';

// Parse Lexical editor richText JSON into plain text
function parseRichText(richTextJson: string): string {
  try {
    interface LexicalNode {
      type: string;
      text?: string;
      children?: LexicalNode[];
      mentionName?: string;
    }

    const extractText = (node: LexicalNode): string => {
      if (node.type === 'text') return node.text || '';
      if (node.type === 'mention') return node.mentionName || node.text || '';
      if (node.children) {
        const childText = node.children.map(extractText).join('');
        return node.type === 'paragraph' ? childText + '\n' : childText;
      }
      return '';
    };

    const parsed: { root: LexicalNode } = JSON.parse(richTextJson);
    return extractText(parsed.root).trim();
  } catch {
    return richTextJson;
  }
}

// Updated extraction logic
function extractMessageTextNew(message: any): string {
  if (message.text) return message.text;

  if (message.richText) {
    const parsed = parseRichText(message.richText);
    if (parsed) return parsed;
  }

  if (message.codeBlocks?.length) {
    const codeContent = message.codeBlocks
      .map((block: any) => block.content || block.code || '')
      .filter((c: string) => c.trim())
      .join('\n\n');
    if (codeContent) return codeContent;
  }

  if (message.toolFormerData?.result) {
    return typeof message.toolFormerData.result === 'string'
      ? message.toolFormerData.result
      : JSON.stringify(message.toolFormerData.result);
  }

  if (message.responseParts && Array.isArray(message.responseParts)) {
    const textParts: string[] = [];
    for (const part of message.responseParts) {
      if (part.type === 'text' && part.rawText) {
        textParts.push(part.rawText);
      }
    }
    if (textParts.length > 0) return textParts.join('\n');
  }

  if (message.thinking) return `[THINKING] ${message.thinking}`;

  return '';
}

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  setDatabasePath(dbPath);

  console.log('=== Testing Updated Message Extraction ===\n');

  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 50,
  });

  const withMessages = conversations.filter(c => c.messageCount > 0).slice(0, 20);

  let total = 0;
  let newExtracted = 0;
  let libraryExtracted = 0;
  let additionalFound = 0;

  for (const conv of withMessages) {
    const { messages } = await listMessages(conv.conversationId, { limit: 500 });

    for (const msg of messages) {
      total++;
      const newText = extractMessageTextNew(msg);
      const libraryText = msg.text || '';

      if (newText) newExtracted++;
      if (libraryText) libraryExtracted++;
      if (newText && !libraryText) {
        additionalFound++;
      }
    }
  }

  console.log(`Total messages: ${total}`);
  console.log(`New extraction: ${newExtracted} (${((newExtracted/total)*100).toFixed(1)}%)`);
  console.log(`Library extraction: ${libraryExtracted} (${((libraryExtracted/total)*100).toFixed(1)}%)`);
  console.log(`Additional messages found: ${additionalFound}`);
})();
