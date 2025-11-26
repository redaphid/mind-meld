#!/usr/bin/env node

import 'dotenv/config';
import { CronJob } from 'cron';
import { runFullSync } from './sync/orchestrator.js';
import { config } from './config.js';

const CRON_EXPRESSION = `0 */${config.sync.intervalMinutes} * * * *`;

console.log('='.repeat(60));
console.log('Mindmeld Sync Daemon');
console.log('='.repeat(60));
console.log(`Cron expression: ${CRON_EXPRESSION}`);
console.log(`Sync interval: Every ${config.sync.intervalMinutes} minutes`);
console.log(`Incremental: ${config.sync.incremental}`);
console.log(`PostgreSQL: ${config.postgres.host}:${config.postgres.port}`);
console.log(`Chroma: ${config.chroma.url}`);
console.log('='.repeat(60));

let isRunning = false;

async function runSync() {
  if (isRunning) {
    console.log('Previous sync still running, skipping...');
    return;
  }

  isRunning = true;

  try {
    await runFullSync({
      incremental: config.sync.incremental,
    });
  } catch (e) {
    console.error('Sync failed:', e);
  } finally {
    isRunning = false;
  }
}

// Create cron job
const job = new CronJob(
  CRON_EXPRESSION,
  runSync,
  null,
  false, // Don't start immediately
  'America/New_York'
);

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down...');
  job.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down...');
  job.stop();
  process.exit(0);
});

// Run initial sync
console.log('\nRunning initial sync...');
runSync().then(() => {
  console.log('\nStarting cron job...');
  job.start();
  console.log(`Next run: ${job.nextDate().toISO()}`);
});
