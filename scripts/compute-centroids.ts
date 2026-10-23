#!/usr/bin/env tsx
/**
 * Compute centroids for all sessions and projects
 * Run this after embeddings have been generated
 */

import { computeAllSessionCentroids, computeAllProjectCentroids } from '../src/services/compute-centroids.js'
import { closePool } from '../src/db/postgres.js'
import { semanticEnabled } from '../src/sync/sync-control.js'

const main = async () => {
  try {
    // Centroids are averages of vectors, so with the semantic switch off there
    // is nothing to compute from. Skipping is not a failure: the container
    // loop sleeps and asks again next interval.
    if (!(await semanticEnabled())) {
      console.log('Semantic is switched off: skipping centroid computation.')
      return
    }

    console.log('Starting centroid computation...\n')

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
