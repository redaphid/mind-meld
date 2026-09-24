#!/usr/bin/env tsx
/**
 * Compute centroids for all sessions and projects
 * Run this after embeddings have been generated
 */

// src/config.ts does not load .env -- only entrypoints do. Without this the
// script silently falls back to the default password and times out connecting.
import 'dotenv/config'

import { computeAllSessionCentroids, computeAllProjectCentroids } from '../src/services/compute-centroids.js'
import { refreshQualityVectors } from '../src/services/quality-vectors.js'
import { closePool } from '../src/db/postgres.js'
import { config } from '../src/config.js'

const main = async () => {
  console.log('Starting centroid computation...\n')

  try {
    // Compute session centroids
    console.log('=== Computing Session Centroids ===')
    await computeAllSessionCentroids()

    console.log('\n=== Computing Project Centroids ===')
    await computeAllProjectCentroids()

    // Must run AFTER session centroids: these are averages OF those centroids,
    // so refreshing them first would describe the previous generation.
    console.log('\n=== Computing Quality Vectors ===')
    await refreshQualityVectors(config.embeddings.dimensions)

    console.log('\n✓ Centroid computation complete!')
  } catch (error) {
    console.error('Error computing centroids:', error)
    process.exit(1)
  } finally {
    await closePool()
  }
}

main()
