import { setDatabasePath, listConversations, listMessages } from '@hypnodroid/cursor-conversations';
import { homedir } from 'os';

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  setDatabasePath(dbPath);

  console.log('=== Inspecting Cursor Conversations Without Messages ===\n');

  const { conversations } = await listConversations({
    sortBy: 'recent_activity',
    sortOrder: 'desc',
    limit: 100,
  });

  // Find conversations with "No preview available"
  const noPreview = conversations.filter(c => c.preview === 'No preview available');

  console.log(`Found ${noPreview.length} conversations with "No preview available"\n`);

  if (noPreview.length > 0) {
    const sample = noPreview[0];
    console.log(`Sample conversation: ${sample.conversationId}`);
    console.log(`Created: ${new Date(sample.createdAt)}`);
    console.log(`Updated: ${new Date(sample.updatedAt)}`);
    console.log(`Preview: ${sample.preview}`);

    const { messages, total } = await listMessages(sample.conversationId, { limit: 50 });
    console.log(`\nMessage count: ${total}`);

    if (messages.length > 0) {
      console.log('\n=== First Message Structure ===');
      console.log(JSON.stringify(messages[0], null, 2));
    } else {
      console.log('\nNo messages found!');
    }
  }
})();
