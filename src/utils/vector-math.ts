/**
 * Vector math utilities for semantic search operations
 */

/**
 * Subtract two vectors (element-wise): a - b
 * Used for negative prompts in semantic search
 */
export const subtractVectors = (a: number[], b: number[]): number[] => {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  return a.map((val, i) => val - b[i])
}

/**
 * Add two vectors (element-wise): a + b
 */
export const addVectors = (a: number[], b: number[]): number[] => {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  return a.map((val, i) => val + b[i])
}

/**
 * Scale a vector by a scalar multiplier
 * Used for weighted centroid contributions
 */
export const scaleVector = (vector: number[], scalar: number): number[] => {
  return vector.map((val) => val * scalar)
}

/**
 * Normalize vector to unit length
 * Important after vector arithmetic to maintain search quality
 */
export const normalizeVector = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (magnitude === 0) return vector
  return vector.map((val) => val / magnitude)
}

/**
 * Magnitude (L2 norm) of a vector.
 *
 * Exported on its own because for a mean of unit vectors this number IS the
 * measurement, not an implementation detail: unit vectors pointing the same way
 * average to length ~1, unit vectors pointing randomly cancel to ~0. See
 * `cohesion` in init-db/024-quality-vectors.sql.
 */
export const magnitude = (vector: number[]): number =>
  Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))

/**
 * Element-wise arithmetic mean of a set of vectors. NOT normalized -- callers
 * that want the direction normalize it themselves, because the length of the
 * mean is often the thing being measured.
 *
 * Throws on an empty set rather than returning zeros: a zero vector is a legal
 * value here (it means "perfectly cancelled"), so silently manufacturing one
 * from no input would be indistinguishable from a real measurement.
 */
export const meanVector = (vectors: number[][]): number[] => {
  if (vectors.length === 0) throw new Error('meanVector: cannot average an empty set')
  const dims = vectors[0].length
  const sum = new Array(dims).fill(0)
  for (const v of vectors) {
    if (v.length !== dims) throw new Error(`Vector dimension mismatch: ${v.length} vs ${dims}`)
    for (let i = 0; i < dims; i++) sum[i] += v[i]
  }
  return sum.map((s) => s / vectors.length)
}

/**
 * Remove the corpus-wide common direction from a vector, then re-normalize.
 *
 * THIS IS NOT COSMETIC. bge-m3 embeddings are strongly anisotropic: every
 * vector in the corpus sits inside a narrow cone, so two entirely unrelated
 * sessions already score ~0.7 cosine against each other. Measured on the live
 * index, the mean of 54 sessions tagged `useless` had magnitude 0.8421 -- and
 * the mean of 54 RANDOM sessions had magnitude 0.7579. The apparent cluster was
 * almost entirely the shared cone.
 *
 * After centering, the same two numbers are 0.5136 and 0.1649. Every comparison
 * against a quality direction must therefore go through this function, or it is
 * measuring the corpus's centre of mass rather than the thing it names.
 *
 * `globalMean` must be the same vector that was used to build whatever the
 * result is compared against -- centering is a change of basis, and mixing
 * bases silently produces numbers that look fine.
 */
export const centerVector = (vector: number[], globalMean: number[]): number[] =>
  normalizeVector(subtractVectors(normalizeVector(vector), globalMean))

/**
 * Compute cosine similarity between two vectors
 * Returns value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let dotProduct = 0
  let magnitudeA = 0
  let magnitudeB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    magnitudeA += a[i] * a[i]
    magnitudeB += b[i] * b[i]
  }
  magnitudeA = Math.sqrt(magnitudeA)
  magnitudeB = Math.sqrt(magnitudeB)
  if (magnitudeA === 0 || magnitudeB === 0) return 0
  return dotProduct / (magnitudeA * magnitudeB)
}
