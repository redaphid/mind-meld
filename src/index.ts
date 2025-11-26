#!/usr/bin/env node

import 'dotenv/config';
import { program } from 'commander';
import { runFullSync, getSyncStatus } from './sync/orchestrator.js';
import { syncClaudeCode } from './sync/claude-code.js';
import { syncCursor } from './sync/cursor.js';
import { generatePendingEmbeddings, updateAggregateEmbeddings } from './embeddings/batch.js';
import { closePool, query } from './db/postgres.js';
import { getCollectionStats, listCollections } from './db/chroma.js';
import { config } from './config.js';

program
  .name('mindmeld')
  .description('Unified conversation index for Claude Code and Cursor')
  .version('0.1.0');

program
  .command('sync')
  .description('Sync conversations from all sources')
  .option('-i, --incremental', 'Only sync new/modified files', true)
  .option('-f, --full', 'Full sync (ignore incremental)', false)
  .option('-s, --source <source>', 'Only sync specific source (claude_code, cursor)')
  .option('--skip-embeddings', 'Skip embedding generation')
  .action(async (options) => {
    try {
      const sources = options.source
        ? [options.source as 'claude_code' | 'cursor']
        : undefined;

      await runFullSync({
        incremental: !options.full,
        skipEmbeddings: options.skipEmbeddings,
        sources,
      });
    } catch (e) {
      console.error('Sync failed:', e);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('embeddings')
  .description('Generate embeddings for messages')
  .action(async () => {
    try {
      console.log('Generating message embeddings...');
      const msgStats = await generatePendingEmbeddings();
      console.log(`Processed ${msgStats.processed} messages`);

      console.log('Updating aggregate embeddings...');
      const aggStats = await updateAggregateEmbeddings();
      console.log(`Updated ${aggStats.sessionsUpdated} sessions`);
    } catch (e) {
      console.error('Embedding generation failed:', e);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('status')
  .description('Show sync status and statistics')
  .action(async () => {
    try {
      const status = await getSyncStatus();

      console.log('\n=== Sync Status ===\n');
      for (const source of status.sources) {
        console.log(`${source.name}:`);
        console.log(`  Last sync: ${source.lastSync?.toISOString() ?? 'Never'}`);
        console.log(`  Files processed: ${source.filesProcessed}`);
        console.log(`  Records synced: ${source.recordsSynced}`);
        if (source.lastError) {
          console.log(`  Last error: ${source.lastError}`);
        }
        console.log();
      }

      console.log('=== Totals ===\n');
      console.log(`Projects: ${status.totals.projects}`);
      console.log(`Sessions: ${status.totals.sessions}`);
      console.log(`Messages: ${status.totals.messages}`);
      console.log(`Embeddings: ${status.totals.embeddings}`);

      // Chroma stats
      console.log('\n=== Chroma Collections ===\n');
      const collections = await listCollections();
      for (const name of collections) {
        const stats = await getCollectionStats(name);
        console.log(`${name}: ${stats.count} embeddings`);
      }
    } catch (e) {
      console.error('Failed to get status:', e);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('search <query>')
  .description('Search conversations')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-s, --source <source>', 'Filter by source (claude_code, cursor)')
  .action(async (searchQuery, options) => {
    try {
      const result = await query(
        'SELECT * FROM search_messages($1, $2, $3)',
        [searchQuery, parseInt(options.limit, 10), options.source ?? null]
      );

      if (result.rows.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`\nFound ${result.rows.length} results:\n`);

      for (const row of result.rows) {
        console.log(`[${row.source_name}] ${row.project_name}`);
        console.log(`  Role: ${row.role}`);
        console.log(`  Time: ${row.timestamp}`);
        console.log(`  Content: ${row.content_text?.slice(0, 200)}...`);
        console.log();
      }
    } catch (e) {
      console.error('Search failed:', e);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('config')
  .description('Show current configuration')
  .action(() => {
    console.log('\n=== Configuration ===\n');
    console.log(`PostgreSQL: ${config.postgres.host}:${config.postgres.port}`);
    console.log(`Chroma: ${config.chroma.url}`);
    console.log(`Ollama: ${config.ollama.url}`);
    console.log(`\nClaude Code path: ${config.sources.claudeCode.path}`);
    console.log(`Cursor path: ${config.sources.cursor.path}`);
    console.log(`\nEmbedding model: ${config.embeddings.model}`);
    console.log(`Embedding dimensions: ${config.embeddings.dimensions}`);
    console.log(`Batch size: ${config.embeddings.batchSize}`);
    console.log(`\nSync interval: ${config.sync.intervalMinutes} minutes`);
    console.log(`Incremental: ${config.sync.incremental}`);
  });

program.parse();
