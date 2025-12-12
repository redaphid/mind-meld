#!/usr/bin/env tsx
/**
 * Compute centroids for all sessions and projects
 * Run this after embeddings have been generated
 */

import { computeAllSessionCentroids, computeAllProjectCentroids } from '../src/services/compute-centroids.js'
import { closePool } from '../src/db/postgres.js'

const main = async () => {
  console.log('Starting centroid computation...\n')

  try {
    // Compute session centroids
    console.log('=== Computing Session Centroids ===')
    await computeAllSessionCentroids()

    console.log('\n=== Computing Project Centroids ===')
    await computeAllProjectCentroids()

    console.log('\n✓ Centroid computation complete!')
  } catch (error) {
    console.error('Error computing centroids:', error)
    process.exit(1)
  } finally {
    await closePool()
  }
}

main()
