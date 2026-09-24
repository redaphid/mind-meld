#!/usr/bin/env tsx
/**
 * Refresh only the quality direction vectors.
 *
 * Separate from compute:centroids (which also runs this) because the two have
 * very different costs: session centroids read every message embedding out of
 * Chroma, while these are an average over centroids that already exist. After
 * tagging a few sessions `useless` you want the second, not the first.
 */

// src/config.ts does not load .env -- only entrypoints do. Without this the
// script silently falls back to the default password and times out connecting.
import 'dotenv/config'

import { refreshQualityVectors } from '../src/services/quality-vectors.js'
import { closePool } from '../src/db/postgres.js'
import { config } from '../src/config.js'

const main = async () => {
  try {
    const result = await refreshQualityVectors(config.embeddings.dimensions)
    if (!result.useless) {
      console.log('No useless direction computed — see the warning above.')
      return
    }
    const { cohesion, baseline, memberCount } = result.useless
    console.log(
      `\nglobal mean over ${result.globalMeanMembers} sessions; ` +
        `useless direction from ${memberCount} labelled sessions.`
    )
    console.log(`cohesion ${cohesion.toFixed(4)} vs random baseline ${baseline.toFixed(4)}.`)
  } catch (error) {
    console.error('Error computing quality vectors:', error)
    process.exit(1)
  } finally {
    await closePool()
  }
}

main()
