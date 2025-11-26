#!/usr/bin/env tsx
import { summarizeConversation } from '../src/embeddings/summarize.js';

async function test() {
  const messages: string[] = [];
  for (let i = 0; i < 100; i++) {
    messages.push('[USER]: How do I fix this TypeScript error in my React component? The useState hook is not working correctly and throwing type errors.');
    messages.push('[ASSISTANT]: Let me check the code. It looks like you need to add the correct type annotation to useState. Here is the fix: useState<string>(""). You also need to import it from react.');
  }

  console.log('Input chars:', messages.join('\n\n').length);
  const result = await summarizeConversation(messages);
  console.log('Output chars:', result.length);
  console.log('---SUMMARY---');
  console.log(result);
}

test().catch(console.error);
