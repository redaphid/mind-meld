import { describe, it, expect } from 'vitest'
import { clampSeriesWindow, bucketSizeFor, DEFAULT_SERIES_MINUTES } from './embedding-series.js'

describe('clampSeriesWindow', () => {
  it('falls back to the default for anything unparseable', () => {
    expect(clampSeriesWindow(undefined)).toBe(DEFAULT_SERIES_MINUTES)
    expect(clampSeriesWindow('')).toBe(DEFAULT_SERIES_MINUTES)
    expect(clampSeriesWindow('banana')).toBe(DEFAULT_SERIES_MINUTES)
    expect(clampSeriesWindow(null)).toBe(DEFAULT_SERIES_MINUTES)
  })

  it('accepts query strings, which is how it always arrives', () => {
    expect(clampSeriesWindow('60')).toBe(60)
  })

  it('clamps to a day at the top, ten minutes at the bottom', () => {
    expect(clampSeriesWindow(99999)).toBe(1440)
    expect(clampSeriesWindow(1)).toBe(10)
    expect(clampSeriesWindow(-5)).toBe(10)
  })
})

describe('bucketSizeFor', () => {
  // The point of the derivation: the caller picks a span, not a resolution,
  // and every span comes back with a comparable number of points.
  it('keeps roughly 60 buckets whatever the window', () => {
    for (const minutes of [60, 360, 720, 1440]) {
      const buckets = minutes / bucketSizeFor(minutes)
      expect(buckets).toBeGreaterThanOrEqual(45)
      expect(buckets).toBeLessThanOrEqual(75)
    }
  })

  it('never returns a zero-width bucket, which would divide by zero', () => {
    expect(bucketSizeFor(10)).toBeGreaterThanOrEqual(1)
    expect(bucketSizeFor(1)).toBeGreaterThanOrEqual(1)
  })
})
