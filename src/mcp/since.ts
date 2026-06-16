import assert from 'node:assert'
import * as chrono from 'chrono-node'
import ms from 'ms'

const DAY_MS = 86_400_000

const ISO_DURATION =
  /^[+-]?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

const isoDurationMs = (value: string) => {
  const match = value.match(ISO_DURATION)
  if (!match || /^[+-]?P$/.test(value)) return null
  const [, y, mo, w, d, h, min, s] = match.map((part) => (part ? parseInt(part) : 0))
  return (y * 365 + mo * 30 + w * 7 + d) * DAY_MS + ((h * 60 + min) * 60 + s) * 1000
}

export const parseSinceDate = (since?: string) => {
  if (!since) return null
  const trimmed = since.trim()

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const epoch = parseFloat(trimmed)
    const seconds = trimmed.split('.')[0].length > 10 ? epoch / 1000 : epoch
    return new Date(seconds * 1000)
  }

  const duration = isoDurationMs(trimmed)
  if (duration !== null) return new Date(Date.now() - duration)

  const relative = ms(trimmed)
  if (relative) return new Date(Date.now() - relative)

  const natural = chrono.parseDate(trimmed)
  assert(
    natural,
    new TypeError(
      `Invalid "since" value: ${since}. Try a duration ("7d", "P3D", "PT12H"), natural language ("3 days ago", "yesterday"), or a timestamp ("2024-01-15").`
    )
  )
  return natural
}
