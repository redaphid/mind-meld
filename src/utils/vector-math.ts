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
