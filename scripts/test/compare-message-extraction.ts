import { setDatabasePath, listConversations, listMessages } from '@redaphid/cursor-conversations';
import { homedir } from 'os';

// Our current extraction logic
function extractMessageTextOld(message: any): string {
  if (message.text) return message.text;

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

  if (message.codeBlocks?.length) {
    return `[${message.codeBlocks.length} code block(s)]`;
  }

  return '';
}

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  setDatabasePath(dbPath);

  console.log('=== Comparing Message Extraction Methods ===\n');

  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 50,
  });

  // Get conversations with messages
  const withMessages = conversations.filter(c => c.messageCount > 0).slice(0, 10);

  let totalMessages = 0;
  let ourExtracted = 0;
  let libraryExtracted = 0;
  let missed = 0;

  for (const conv of withMessages) {
    const { messages } = await listMessages(conv.conversationId, { limit: 500 });
    totalMessages += messages.length;

    for (const msg of messages) {
      const ourText = extractMessageTextOld(msg);
      const libraryText = msg.text || '';

      if (ourText) ourExtracted++;
      if (libraryText) libraryExtracted++;
      if (!ourText && libraryText) {
        missed++;
        if (missed <= 5) {
          console.log(`\n=== Missed Message ===`);
          console.log(`Message ID: ${msg.messageId}`);
          console.log(`Type: ${msg.type}`);
          console.log(`Library extracted: "${libraryText.slice(0, 100)}..."`);
          console.log(`Message has:`);
          console.log(`  - text: ${!!msg.text}`);
          console.log(`  - richText: ${!!msg.richText}`);
          console.log(`  - codeBlocks: ${!!msg.codeBlocks}`);
          console.log(`  - toolFormerData: ${!!msg.toolFormerData}`);
          console.log(`  - responseParts: ${!!msg.responseParts}`);
        }
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total messages checked: ${totalMessages}`);
  console.log(`Our extraction found: ${ourExtracted} (${((ourExtracted/totalMessages)*100).toFixed(1)}%)`);
  console.log(`Library extraction found: ${libraryExtracted} (${((libraryExtracted/totalMessages)*100).toFixed(1)}%)`);
  console.log(`Messages we MISSED: ${missed} (${((missed/totalMessages)*100).toFixed(1)}%)`);
})();
