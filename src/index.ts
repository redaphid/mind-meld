#!/usr/bin/env node

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { program } from 'commander';
import { runFullSync, getSyncStatus } from './sync/orchestrator.js';
import { buildRunReport } from './sync/run-report.js';
import { verifyClaudeCode, formatVerifyReport, verifyExitCode } from './sync/verify.js';
import { listMemories, listVersions, restoreMemory } from './sync/memory-restore.js';
import { generatePendingEmbeddings, updateAggregateEmbeddings } from './embeddings/batch.js';
import { closePool, query } from './db/postgres.js';
import { getCollectionStats, listCollections } from './db/chroma.js';
import { config } from './config.js';
import { captureConsole } from './mcp/log-buffer.js';
import { startDbLogSink, installFlushOnExit } from './logging/db-sink.js';

// Sync runs on several machines and in containers whose stdout nobody else can
// read; shipping to the shared `logs` table is what makes /logs cover them.
captureConsole(startDbLogSink('sync'));
installFlushOnExit();

program
  .name('mindmeld')
  .description('Unified conversation index for Claude Code and Codex')
  .version('0.1.0');

const SYNC_TIMER = 'mindmeld-sync.timer';
const SYNC_SERVICE = 'mindmeld-sync.service';

const systemctl = (args: string[], opts: { quiet?: boolean } = {}) =>
  execFileSync('systemctl', ['--user', ...args], {
    stdio: opts.quiet ? 'pipe' : 'inherit',
  });

const requireSyncTimer = () => {
  try {
    systemctl(['cat', SYNC_TIMER], { quiet: true });
  } catch {
    console.error(
      `${SYNC_TIMER} is not installed on this machine (expected in ~/.config/systemd/user/).`
    );
    process.exit(1);
  }
};

program
  .command('start')
  .description('Enable scheduled syncing (hourly systemd timer)')
  .action(() => {
    requireSyncTimer();
    systemctl(['enable', '--now', SYNC_TIMER]);
    console.log('Scheduled syncing enabled.');
    systemctl(['list-timers', SYNC_TIMER, '--no-pager']);
  });

program
  .command('stop')
  .description('Disable scheduled syncing and stop any in-flight sync run')
  .action(() => {
    requireSyncTimer();
    systemctl(['disable', '--now', SYNC_TIMER]);
    try {
      systemctl(['stop', SYNC_SERVICE], { quiet: true });
    } catch {
      // service wasn't running — nothing to stop
    }
    console.log('Scheduled syncing disabled.');
  });

program
  .command('sync')
  .description('Sync conversations from all sources')
  .option('-i, --incremental', 'Only sync new/modified files')
  .option('-f, --full', 'Full sync (ignore incremental)')
  .option('-s, --source <source>', 'Only sync specific source (claude_code, codex)')
  .option('--skip-embeddings', 'Skip embedding generation')
  .action(async (options) => {
    try {
      // An unknown --source used to silently sync nothing and exit 0 — the
      // same invisible-failure class as #29. Reject it loudly instead.
      const KNOWN_SOURCES = ['claude_code', 'codex'] as const;
      if (options.source && !KNOWN_SOURCES.includes(options.source)) {
        console.error(
          `Unknown source "${options.source}". Valid sources: ${KNOWN_SOURCES.join(', ')}`
        );
        process.exitCode = 1;
        return;
      }
      const sources = options.source
        ? [options.source as 'claude_code' | 'codex']
        : undefined;

      // Determine incremental mode: false if --full is set, true if --incremental is set, default to true
      const incremental = options.full ? false : (options.incremental !== undefined ? options.incremental : true);

      console.log('DEBUG: options.full =', options.full);
      console.log('DEBUG: options.incremental =', options.incremental);
      console.log('DEBUG: options.skipEmbeddings =', options.skipEmbeddings);
      console.log('DEBUG: computed incremental =', incremental);

      const result = await runFullSync({
        incremental,
        skipEmbeddings: options.skipEmbeddings,
        sources,
      });

      // A run that recorded errors must exit nonzero, or the container loop
      // around this command reports a data-dropping run as a success (#29).
      // process.exitCode (not process.exit) so the pool still closes cleanly.
      const report = buildRunReport(result);
      console.log('\n' + report.lines.join('\n'));
      if (report.exitCode !== 0) {
        console.error(`Sync finished with ${result.errors.length} error(s); exiting nonzero.`);
        process.exitCode = report.exitCode;
      }
    } catch (e) {
      console.error('Sync failed:', e);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  });

program
  .command('verify')
  .description(
    'Compare each Claude Code session file on disk against the database and report drift'
  )
  .option('--repair', 'Clear the sync stamp on drifted sessions so the next incremental sync reprocesses them, and recompute their stats')
  .option('-p, --project <filter>', 'Only verify projects whose decoded path contains this string')
  .action(async (options) => {
    try {
      const result = await verifyClaudeCode({
        repair: options.repair,
        projectFilter: options.project,
      });

      console.log(formatVerifyReport(result, Boolean(options.repair)).join('\n'));

      const exitCode = verifyExitCode(result);
      if (exitCode !== 0) process.exitCode = exitCode;
    } catch (e) {
      console.error('Verify failed:', e);
      process.exitCode = 1;
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
  .command('memories [action]')
  .description(
    'Claude Code memory backup: list (default), versions <project> <name>, or restore'
  )
  .option('-p, --project <filter>', 'Only memories whose project slug or path contains this')
  .option('-o, --out <dir>', 'Restore into this directory instead of the original location')
  .option(
    '--force',
    'Overwrite a file whose text differs from the stored version (default: refuse and report)'
  )
  .option('-a, --args <args...>', 'Arguments for `versions`: <projectExternalId> <memoryName>')
  .action(async (action: string | undefined, options) => {
    try {
      const act = action ?? 'list';

      if (act === 'versions') {
        const [projectExternalId, fileName] = options.args ?? [];
        if (!projectExternalId || !fileName) {
          console.error('Usage: mindmeld memories versions -a <projectExternalId> <memoryName>');
          process.exitCode = 1;
          return;
        }
        const versions = await listVersions({ projectExternalId, fileName });
        if (versions.length === 0) {
          console.log(`No stored versions for ${projectExternalId}/${fileName}`);
          return;
        }
        console.log(`${versions.length} stored version(s) of ${fileName}:`);
        for (const v of versions) {
          console.log(
            `  v${v.versionNum}  ${v.timestamp.toISOString()}  ${v.contentHash.slice(0, 12)}  ${v.content.length} chars`
          );
        }
        return;
      }

      const memories = await listMemories({ projectFilter: options.project });

      if (act === 'list') {
        console.log(`${memories.length} memor(ies) backed up:`);
        for (const m of memories) {
          // The version count is the whole point of the list: anything above 1
          // has superseded text that exists in no other place.
          console.log(
            `  ${m.projectExternalId}/${m.fileName}  v${m.versionNum}  ${m.timestamp.toISOString().slice(0, 10)}`
          );
        }
        return;
      }

      if (act === 'restore') {
        let written = 0;
        let identical = 0;
        const skipped: string[] = [];
        for (const m of memories) {
          const outcome = await restoreMemory(m, { outDir: options.out, force: options.force });
          if (outcome.status === 'written') written++;
          else if (outcome.status === 'identical') identical++;
          else skipped.push(outcome.targetPath);
        }
        console.log(
          `Restore complete: ${written} written, ${identical} already identical, ${skipped.length} skipped`
        );
        // Skips are the interesting outcome, not an aside: each one is a file
        // on disk that differs from the backup, which usually means it is
        // NEWER than the last sync. Naming them is what stops --force from
        // being the reflex.
        for (const path of skipped) {
          console.log(`  skipped (differs on disk, use --force to overwrite): ${path}`);
        }
        return;
      }

      console.error(`Unknown action "${act}". Valid actions: list, versions, restore`);
      process.exitCode = 1;
    } catch (e) {
      console.error('Memory command failed:', e);
      process.exitCode = 1;
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
  .option('-s, --source <source>', 'Filter by source (claude_code, codex)')
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
    console.log(`Codex path: ${config.sources.codex.path}`);
    console.log(`\nEmbedding model: ${config.embeddings.model}`);
    console.log(`Embedding dimensions: ${config.embeddings.dimensions}`);
    console.log(`Batch size: ${config.embeddings.batchSize}`);
    console.log(`\nSync interval: ${config.sync.intervalMinutes} minutes`);
    console.log(`Incremental: ${config.sync.incremental}`);
  });

program.parse();
