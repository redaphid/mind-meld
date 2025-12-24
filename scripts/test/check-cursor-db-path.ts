import { homedir } from 'os';
import { existsSync } from 'fs';
import { stat, readdir } from 'fs/promises';
import { join } from 'path';

(async () => {
  const dbPath = `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;

  console.log('=== Checking Cursor Database Path ===\n');
  console.log('Path:', dbPath);
  console.log('Exists:', existsSync(dbPath));

  if (existsSync(dbPath)) {
    const stats = await stat(dbPath);
    console.log('Size:', (stats.size / 1024 / 1024).toFixed(2), 'MB');
    console.log('Modified:', stats.mtime);
  } else {
    console.log('\nDatabase not found. Searching for Cursor directories...\n');

    // Check common locations
    const locations = [
      `${homedir()}/Library/Application Support/Cursor`,
      `${homedir()}/.cursor`,
      `${homedir()}/Library/Application Support/Code`,
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        console.log(`✓ Found: ${loc}`);
        try {
          const files = await readdir(loc);
          console.log(`  Contents:`, files.slice(0, 10).join(', '));
        } catch (e) {
          console.log(`  (Could not read directory)`);
        }
      }
    }
  }
})();
