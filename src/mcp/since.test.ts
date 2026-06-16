import { describe, it, expect, beforeEach } from 'vitest'
import { parseSinceDate, sinceSchema } from './since.js'

const approxAgo = (date: Date, ms: number) => Math.abs(Date.now() - ms - date.getTime())

describe('parseSinceDate', () => {
  it('returns null when no value is given', () => {
    expect(parseSinceDate()).toBeNull()
  })

  describe('when given a relative shorthand', () => {
    it('subtracts days for "7d"', () => {
      expect(approxAgo(parseSinceDate('7d')!, 7 * 86_400_000)).toBeLessThan(1000)
    })

    it('subtracts hours for "24h"', () => {
      expect(approxAgo(parseSinceDate('24h')!, 24 * 3_600_000)).toBeLessThan(1000)
    })

    it('subtracts minutes for "30m"', () => {
      expect(approxAgo(parseSinceDate('30m')!, 30 * 60_000)).toBeLessThan(1000)
    })
  })

  describe('when given an ISO-8601 duration', () => {
    it('subtracts days for "P3D"', () => {
      expect(approxAgo(parseSinceDate('P3D')!, 3 * 86_400_000)).toBeLessThan(1000)
    })

    it('treats a leading minus the same as backward-looking ("-P3D")', () => {
      expect(approxAgo(parseSinceDate('-P3D')!, 3 * 86_400_000)).toBeLessThan(1000)
    })

    it('subtracts hours for "PT12H"', () => {
      expect(approxAgo(parseSinceDate('PT12H')!, 12 * 3_600_000)).toBeLessThan(1000)
    })

    it('does not treat a bare "P" as a duration', () => {
      expect(() => parseSinceDate('P')).toThrow(TypeError)
    })
  })

  describe('when given natural language', () => {
    it('resolves "yesterday" to roughly a day ago', () => {
      expect(approxAgo(parseSinceDate('yesterday')!, 86_400_000)).toBeLessThan(86_400_000)
    })
  })

  describe('when given an absolute timestamp', () => {
    it('parses an ISO date', () => {
      expect(parseSinceDate('2024-01-01T00:00:00Z')!.toISOString()).toBe('2024-01-01T00:00:00.000Z')
    })

    it('parses a 10-digit epoch as seconds', () => {
      expect(parseSinceDate('1700000000')!.toISOString()).toBe('2023-11-14T22:13:20.000Z')
    })
  })

  describe('when the value cannot be parsed', () => {
    let error: unknown

    beforeEach(() => {
      try {
        parseSinceDate('not-a-time')
      } catch (e) {
        error = e
      }
    })

    it('throws a TypeError', () => {
      expect(error).toBeInstanceOf(TypeError)
    })

    it('names the offending value', () => {
      expect((error as Error).message).toContain('not-a-time')
    })
  })
})

describe('sinceSchema', () => {
  describe('when the value is parseable', () => {
    it('accepts an ISO-8601 duration', () => {
      expect(sinceSchema.safeParse('-P3D').success).toBe(true)
    })

    it('accepts natural language', () => {
      expect(sinceSchema.safeParse('3 days ago').success).toBe(true)
    })
  })

  describe('when the value is unparseable', () => {
    let result: ReturnType<typeof sinceSchema.safeParse>

    beforeEach(() => {
      result = sinceSchema.safeParse('not-a-time')
    })

    it('rejects', () => {
      expect(result.success).toBe(false)
    })

    it('reports a hint naming the value', () => {
      expect(result.success ? '' : result.error.issues[0].message).toContain('not-a-time')
    })
  })
})
