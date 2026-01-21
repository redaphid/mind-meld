import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, basename } from 'path';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
import { createHash } from 'crypto';

export interface HuddleSyncStats {
  huddlesProcessed: number;
  messagesInserted: number;
  skipped: number;
  errors: string[];
}

interface ParsedCaption {
  speaker: string;
  timestamp: string;
  text: string;
  sequenceNum: number;
}

interface ParsedHuddle {
  channel: string;
  startedAt: Date;
  captions: ParsedCaption[];
  rawContent: string;
}

// Parse the markdown huddle transcript format
function parseHuddleTranscript(content: string, filename: string): ParsedHuddle {
  const lines = content.split('\n');
  const captions: ParsedCaption[] = [];

  // Extract channel from header: "# Huddle Transcript - #channel-name"
  const headerMatch = lines[0]?.match(/^# Huddle Transcript - #(.+)$/);
  if (!headerMatch?.[1]) {
    throw new Error(`Invalid huddle transcript: missing channel header in ${filename}`);
  }
  const channel = headerMatch[1];

  // Extract start time: "*Started: 1/20/2026, 4:55:37 PM*"
  const startMatch = lines[2]?.match(/^\*Started: (.+)\*$/);
  const startedAt = startMatch ? new Date(startMatch[1]) : extractTimestampFromFilename(filename);

  // Parse captions: **speaker** *(timestamp)*: text
  const captionRegex = /^\*\*(.+?)\*\* \*\((.+?)\)\*: (.+)$/;
  let sequenceNum = 0;

  for (const line of lines) {
    const match = line.match(captionRegex);
    if (match) {
      captions.push({
        speaker: match[1],
        timestamp: match[2],
        text: match[3],
        sequenceNum: sequenceNum++,
      });
    }
  }

  return {
    channel,
    startedAt,
    captions,
    rawContent: content,
  };
}

// Extract timestamp from filename: "team-headless-2026-01-20T23-55-37.md"
function extractTimestampFromFilename(filename: string): Date {
  const withoutExt = filename.replace(/\.md$/, '');
  // Match ISO-like timestamp with hyphens instead of colons: 2026-01-20T23-55-37
  const timestampMatch = withoutExt.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
  if (timestampMatch) {
    // Convert 2026-01-20T23-55-37 to 2026-01-20T23:55:37
    const isoString = timestampMatch[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
    return new Date(isoString);
  }
  return new Date();
}

// Generate a unique external ID for a huddle based on channel and start time
function generateHuddleExternalId(channel: string, startedAt: Date): string {
  return `huddle-${channel}-${startedAt.toISOString()}`;
}

// Generate a unique message ID based on content
function generateMessageExternalId(huddleExternalId: string, caption: ParsedCaption): string {
  const hash = createHash('md5')
    .update(`${huddleExternalId}-${caption.sequenceNum}-${caption.speaker}-${caption.text}`)
    .digest('hex')
    .slice(0, 12);
  return `${huddleExternalId}-msg-${caption.sequenceNum}-${hash}`;
}

// List all markdown files in the huddles directory
async function listHuddleFiles(huddlesPath: string): Promise<string[]> {
  try {
    const entries = await readdir(huddlesPath);
    return entries
      .filter(entry => entry.endsWith('.md'))
      .map(entry => join(huddlesPath, entry))
      .sort(); // Sort by filename (chronological due to timestamp naming)
  } catch (e) {
    console.error(`Failed to list huddle files in ${huddlesPath}:`, e);
    return [];
  }
}

// Main sync function for Slack Huddles
export async function syncHuddles(options?: { incremental?: boolean }): Promise<HuddleSyncStats> {
  const stats: HuddleSyncStats = {
    huddlesProcessed: 0,
    messagesInserted: 0,
    skipped: 0,
    errors: [],
  };

  const huddlesPath = config.sources.huddle.path;
  console.log(`Syncing Slack huddles from ${huddlesPath}...`);

  // Get source ID
  const source = await queries.getSourceByName('huddle');
  if (!source) {
    stats.errors.push('Huddle source not found in database. Run migration 007-huddle-source.sql first.');
    return stats;
  }

  // Cache for project IDs (channels → project)
  const projectCache = new Map<string, number>();

  try {
    const huddleFiles = await listHuddleFiles(huddlesPath);
    console.log(`Found ${huddleFiles.length} huddle transcript(s)`);

    for (const filePath of huddleFiles) {
      try {
        const filename = basename(filePath);
        const fileStat = await stat(filePath);
        const fileModifiedAt = fileStat.mtime;

        // Read and parse the transcript
        const content = await readFile(filePath, 'utf-8');
        const huddle = parseHuddleTranscript(content, filename);

        // Get or create project for this channel
        let projectId = projectCache.get(huddle.channel);
        if (!projectId) {
          projectId = await queries.upsertProject(
            source.id,
            huddle.channel, // external_id = channel name
            huddlesPath,    // path
            `#${huddle.channel}` // name (display name with hash)
          );
          projectCache.set(huddle.channel, projectId);
        }

        // Generate external ID for this huddle
        const huddleExternalId = generateHuddleExternalId(huddle.channel, huddle.startedAt);

        // Check if session exists (for incremental sync)
        const existingSession = await queries.getSessionByExternalIdGlobal(source.id, huddleExternalId);

        if (existingSession && options?.incremental) {
          // Skip if file hasn't been modified
          const storedModifiedAt = existingSession.file_modified_at?.getTime() ?? 0;
          if (fileModifiedAt.getTime() <= storedModifiedAt) {
            stats.skipped++;
            continue;
          }
          console.log(`  Re-syncing ${filename}: file modified`);
        }

        // Calculate end time from last caption (if available)
        const lastCaption = huddle.captions[huddle.captions.length - 1];
        let endedAt = huddle.startedAt;
        if (lastCaption) {
          // Parse the relative timestamp and combine with startedAt date
          try {
            const timeMatch = lastCaption.timestamp.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
            if (timeMatch) {
              const [, hours, mins, secs, period] = timeMatch;
              const endDate = new Date(huddle.startedAt);
              let h = parseInt(hours, 10);
              if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
              if (period.toUpperCase() === 'AM' && h === 12) h = 0;
              endDate.setHours(h, parseInt(mins, 10), parseInt(secs, 10));
              endedAt = endDate;
            }
          } catch {
            // Fall back to startedAt if parsing fails
          }
        }

        // Create session title from channel and date
        const sessionTitle = `Huddle in #${huddle.channel} - ${huddle.startedAt.toLocaleDateString()}`;

        // Upsert session
        const sessionId = await queries.upsertSession({
          projectId,
          externalId: huddleExternalId,
          title: sessionTitle,
          rawFilePath: filePath,
          fileModifiedAt,
          startedAt: huddle.startedAt,
          endedAt,
        });

        // Insert header message with channel name
        const headerExternalId = `${huddleExternalId}-header`;
        await queries.insertMessage({
          sessionId,
          externalId: headerExternalId,
          role: 'system',
          contentText: `# ${huddle.channel}`,
          timestamp: huddle.startedAt,
          sequenceNum: -1,
        });

        // Insert captions as messages
        for (const caption of huddle.captions) {
          const messageExternalId = generateMessageExternalId(huddleExternalId, caption);

          // Parse caption timestamp to full datetime
          let captionTime = huddle.startedAt;
          try {
            const timeMatch = caption.timestamp.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
            if (timeMatch) {
              const [, hours, mins, secs, period] = timeMatch;
              captionTime = new Date(huddle.startedAt);
              let h = parseInt(hours, 10);
              if (period.toUpperCase() === 'PM' && h !== 12) h += 12;
              if (period.toUpperCase() === 'AM' && h === 12) h = 0;
              captionTime.setHours(h, parseInt(mins, 10), parseInt(secs, 10));
            }
          } catch {
            // Use startedAt if parsing fails
          }

          // Treat all captions as "user" messages (spoken by humans)
          // Could differentiate by speaker in the future
          const msgId = await queries.insertMessage({
            sessionId,
            externalId: messageExternalId,
            role: 'user', // All huddle messages are spoken by users
            contentText: `**${caption.speaker}**: ${caption.text}`,
            contentJson: {
              speaker: caption.speaker,
              text: caption.text,
              rawTimestamp: caption.timestamp,
              source: 'slack_huddle',
            },
            timestamp: captionTime,
            sequenceNum: caption.sequenceNum,
          });

          if (msgId) stats.messagesInserted++;
        }

        // Update session stats
        await queries.updateSessionStats(sessionId);
        await queries.updateSessionContentChars(sessionId);

        stats.huddlesProcessed++;
        console.log(`  Processed: ${filename} (${huddle.captions.length} captions)`);

      } catch (e) {
        const error = `Failed to sync huddle ${filePath}: ${e}`;
        console.error(error);
        stats.errors.push(error);
      }
    }
  } catch (e) {
    const error = `Failed to list huddle files: ${e}`;
    console.error(error);
    stats.errors.push(error);
  }

  // Update sync state
  await queries.updateSyncState(
    source.id,
    'sessions',
    stats.huddlesProcessed,
    stats.messagesInserted,
    stats.errors.length > 0 ? stats.errors.join('; ') : undefined
  );

  console.log(
    `Huddle sync complete: ${stats.huddlesProcessed} huddles, ${stats.messagesInserted} messages`
  );

  return stats;
}
