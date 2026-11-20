import { describe, it, expect } from 'vitest'
import { sessionVectorId, sessionIdFromVectorId } from './vector-ids.js'

describe('session vector ids', () => {
  it('round-trips a session id', () => {
    expect(sessionIdFromVectorId(sessionVectorId(2177869))).toBe(2177869)
  })
})
