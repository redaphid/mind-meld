import { setDatabasePath, listConversations, listMessages } from '@hypnodroid/cursor-conversations';
import { homedir } from 'os';

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  setDatabasePath(dbPath);

  console.log('=== Analyzing All Message Formats ===\n');

  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 100,
  });

  const withMessages = conversations.filter(c => c.messageCount > 0).slice(0, 20);

  const formats = {
    hasText: 0,
    hasRichText: 0,
    hasCodeBlocks: 0,
    hasResponseParts: 0,
    hasToolFormerData: 0,
    hasThinking: 0,
    hasToolResults: 0,
    noContent: 0,
  };

  let total = 0;

  for (const conv of withMessages) {
    const { messages } = await listMessages(conv.conversationId, { limit: 500 });

    for (const msg of messages) {
      total++;
      if (msg.text) formats.hasText++;
      if (msg.richText) formats.hasRichText++;
      if (msg.codeBlocks?.length) formats.hasCodeBlocks++;
      if (msg.responseParts?.length) formats.hasResponseParts++;
      if (msg.toolFormerData) formats.hasToolFormerData++;
      if (msg.thinking) formats.hasThinking++;
      if (msg.toolResults?.length) formats.hasToolResults++;

      if (!msg.text && !msg.richText && !msg.codeBlocks?.length &&
          !msg.responseParts?.length && !msg.toolFormerData && !msg.thinking) {
        formats.noContent++;
      }
    }
  }

  console.log(`Total messages: ${total}\n`);
  console.log('Field frequencies:');
  console.log(`  text:           ${formats.hasText} (${((formats.hasText/total)*100).toFixed(1)}%)`);
  console.log(`  richText:       ${formats.hasRichText} (${((formats.hasRichText/total)*100).toFixed(1)}%)`);
  console.log(`  codeBlocks:     ${formats.hasCodeBlocks} (${((formats.hasCodeBlocks/total)*100).toFixed(1)}%)`);
  console.log(`  responseParts:  ${formats.hasResponseParts} (${((formats.hasResponseParts/total)*100).toFixed(1)}%)`);
  console.log(`  toolFormerData: ${formats.hasToolFormerData} (${((formats.hasToolFormerData/total)*100).toFixed(1)}%)`);
  console.log(`  thinking:       ${formats.hasThinking} (${((formats.hasThinking/total)*100).toFixed(1)}%)`);
  console.log(`  toolResults:    ${formats.hasToolResults} (${((formats.hasToolResults/total)*100).toFixed(1)}%)`);
  console.log(`\nNo content:       ${formats.noContent} (${((formats.noContent/total)*100).toFixed(1)}%)`);

  // Show library's processing
  console.log('\n=== How Library Processes Messages ===');
  console.log('The cursor-conversations library:');
  console.log('1. Parses richText into plain text');
  console.log('2. Extracts content from codeBlocks');
  console.log('3. Extracts toolFormerData.result');
  console.log('4. Stores result in msg.text and REMOVES msg.richText');
  console.log('\nSo the library returns pre-processed messages with text field populated.');
})();
