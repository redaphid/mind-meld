import { setDatabasePath, listConversations, queryAll } from '@hypnodroid/cursor-conversations';
import { homedir } from 'os';

// Our extraction function
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

function extractMessageText(message: any): string {
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

  console.log('=== Debugging Cursor Message Extraction ===\n');

  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 10,
  });

  const withMessages = conversations.filter(c => c.messageCount > 0);

  if (withMessages.length > 0) {
    const conv = withMessages[0];
    console.log(`Testing conversation: ${conv.conversationId}`);
    console.log(`Message count (from summary): ${conv.messageCount}\n`);

    // Query raw messages like we do in sync
    const messagePattern = `bubbleId:${conv.conversationId}:%`;
    const messageRows = await queryAll<{ key: string; value: string }>(`
      SELECT key, value
      FROM cursorDiskKV
      WHERE key LIKE ?
      LIMIT 500
    `, [messagePattern]);

    console.log(`Raw message rows from database: ${messageRows.length}`);

    // Parse messages
    const messages: any[] = [];
    for (const row of messageRows) {
      if (!row.value || row.value === 'null') {
        console.log('  Skipped: null value');
        continue;
      }
      try {
        const parsed = JSON.parse(row.value);
        const messageId = parsed.bubbleId || row.key.split(':')[2];
        messages.push({ ...parsed, messageId });
      } catch (e) {
        console.log('  Skipped: parse error');
        continue;
      }
    }

    console.log(`Parsed messages: ${messages.length}`);

    // Extract text
    let extracted = 0;
    let skipped = 0;
    for (const msg of messages) {
      const text = extractMessageText(msg);
      if (text) {
        extracted++;
      } else {
        skipped++;
        if (skipped <= 3) {
          console.log(`\nSkipped message ${msg.messageId}:`);
          console.log(`  type: ${msg.type}`);
          console.log(`  has text: ${!!msg.text}`);
          console.log(`  has richText: ${!!msg.richText}`);
          console.log(`  has codeBlocks: ${!!msg.codeBlocks}`);
          console.log(`  has toolFormerData: ${!!msg.toolFormerData}`);
          console.log(`  has thinking: ${!!msg.thinking}`);
        }
      }
    }

    console.log(`\nExtracted: ${extracted}`);
    console.log(`Skipped (no text): ${skipped}`);
  }
})();
