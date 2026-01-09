import { setDatabasePath, listConversations, listMessages, queryAll } from '@hypnodroid/cursor-conversations';
import { homedir } from 'os';

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  setDatabasePath(dbPath);

  console.log('=== Deep Cursor Database Investigation ===\n');

  // Get one empty conversation
  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 100,
  });

  const emptyConvs = conversations.filter(c => c.preview === 'No preview available');
  console.log(`Found ${emptyConvs.length} conversations with "No preview available"\n`);

  if (emptyConvs.length > 0) {
    const sample = emptyConvs[0];
    console.log(`Sample conversation: ${sample.conversationId}`);
    console.log(`Message count from summary: ${sample.messageCount}`);
    console.log(`Preview: ${sample.preview}`);

    // Try to get messages using the library
    const { messages, count } = await listMessages(sample.conversationId, { limit: 500 });
    console.log(`\nMessages from listMessages(): ${count}`);

    // Now query the database directly for this conversation's messages
    const directQuery = await queryAll<{ key: string; value: string }>(`
      SELECT key, value
      FROM cursorDiskKV
      WHERE key LIKE ?
    `, [`bubbleId:${sample.conversationId}:%`]);

    console.log(`\nDirect database query: ${directQuery.length} rows`);

    if (directQuery.length > 0) {
      console.log('\n=== Sample Message Data ===');
      const first = directQuery[0];
      console.log(`Key: ${first.key}`);
      console.log(`Value length: ${first.value?.length || 0} chars`);
      if (first.value && first.value !== 'null') {
        try {
          const parsed = JSON.parse(first.value);
          console.log('\nParsed message structure:');
          console.log(JSON.stringify(parsed, null, 2).slice(0, 1000));
        } catch (e) {
          console.log(`Failed to parse: ${e}`);
        }
      }
    }

    // Also check for different key patterns
    console.log('\n=== Checking All Key Patterns for this Conversation ===');
    const patterns = [
      `composerData:${sample.conversationId}`,
      `bubbleId:${sample.conversationId}:%`,
      `checkpointId:${sample.conversationId}:%`,
      `messageRequestContext:${sample.conversationId}:%`,
    ];

    for (const pattern of patterns) {
      const rows = await queryAll<{ key: string }>(`
        SELECT key FROM cursorDiskKV WHERE key LIKE ?
      `, [pattern]);
      console.log(`  ${pattern}: ${rows.length} entries`);
    }
  }

  // Now let's check a conversation that DOES have messages
  console.log('\n\n=== Checking Conversations WITH Messages ===\n');
  const withMessages = conversations.filter(c => c.preview !== 'No preview available' && c.messageCount > 0);
  if (withMessages.length > 0) {
    const goodSample = withMessages[0];
    console.log(`Sample conversation: ${goodSample.conversationId}`);
    console.log(`Message count: ${goodSample.messageCount}`);
    console.log(`Preview: ${goodSample.preview}`);

    const { messages, count } = await listMessages(goodSample.conversationId, { limit: 500 });
    console.log(`Messages from listMessages(): ${count}`);

    if (messages.length > 0) {
      console.log('\n=== First Message Structure ===');
      const msg = messages[0];
      console.log(`Message ID: ${msg.messageId}`);
      console.log(`Type: ${msg.type}`);
      console.log(`Text: ${msg.text?.slice(0, 200)}...`);
      console.log(`Has codeBlocks: ${!!msg.codeBlocks}`);
      console.log(`Has toolResults: ${!!msg.toolResults}`);
    }
  }
})();
