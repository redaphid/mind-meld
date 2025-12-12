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
 * Normalize vector to unit length
 * Important after vector arithmetic to maintain search quality
 */
export const normalizeVector = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
  if (magnitude === 0) return vector
  return vector.map((val) => val / magnitude)
}
