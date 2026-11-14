import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getHealth, formatHealth } = await import('./health.js')

type Row = Record<string, unknown>
const rows = (...r: Row[]) => ({ rows: r })

beforeEach(() => {
  query.mockReset()
})

const wireQueries = (overrides: {
  coverage?: Row
  bad?: Row
  embeddings?: Row
  sessions?: Row[]
}) => {
  const coverage = { total: '100', summarized: '90', null_backlog: '10', ...overrides.coverage }
  const bad = {
    truncated: '0',
    marker_only: '0',
    no_update: '0',
    refusal: '0',
    raw_message_leak: '0',
    too_short: '0',
    over_compressed: '0',
    loopy: '0',
    json_dump: '0',
    code_dump: '0',
    unsummarizable: '0',
    any_bad: '0',
    ...overrides.bad,
  }
  const embeddings = {
    sessions_age_s: '120',
    messages_age_s: '60',
    pending_msgs: '5',
    ...overrides.embeddings,
  }
  query.mockImplementation((sql: string) => {
    if (sql.includes('null_backlog')) return Promise.resolve(rows(coverage))
    if (sql.includes('any_bad')) return Promise.resolve(rows(bad))
    if (sql.includes('pending_msgs')) return Promise.resolve(rows(embeddings))
    if (sql.includes('AS opening')) return Promise.resolve(rows(...(overrides.sessions ?? [])))
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`)
  })
}

describe('getHealth', () => {
  // The count that would have shown 798 sessions drifting for two months (#177).
  it('counts sessions whose stored automated flag disagrees with the classifier, by direction', async () => {
    const session = (id: number, stored: boolean, opening: string) => ({ id, source: 'claude_code', machine: null, stored, opening })
    wireQueries({
      sessions: [
        session(1, false, 'You are a Slack monitoring assistant for the lair'),
        session(2, true, 'Fix the lantern'),
        session(3, true, 'You are a curiosity curator'),
        session(4, false, 'Fix the kraken'),
      ],
    })
    const h = await getHealth()
    expect(h.automatedFlagDrift).toEqual({ unflagged: 1, unexplained: 1 })
    expect(formatHealth(h)).toContain('Should be flagged and is not: 1')
    expect(formatHealth(h)).toContain('Flagged, and this process\x27s rule does not explain it: 1')
    expect(formatHealth(h)).toContain('Automated Flags: UNHEALTHY')
  })

  it('calls automated flags healthy only when neither count is set', async () => {
    wireQueries({ sessions: [{ id: 1, source: 'claude_code', machine: null, stored: false, opening: 'Fix the lantern' }] })
    expect(formatHealth(await getHealth())).toContain('Automated Flags: HEALTHY')
  })

  it('computes coverage as summarized / (summarized + null backlog)', async () => {
    wireQueries({ coverage: { total: '100', summarized: '90', null_backlog: '10' } })
    const h = await getHealth()
    expect(h.coveragePct).toBeCloseTo(90)
    expect(h.totalSessions).toBe(100)
    expect(h.summarizedSessions).toBe(90)
    expect(h.nullBacklog).toBe(10)
  })

  it('reports 100% coverage when there is nothing to summarize (no divide-by-zero)', async () => {
    wireQueries({ coverage: { total: '0', summarized: '0', null_backlog: '0' } })
    const h = await getHealth()
    expect(h.coveragePct).toBe(100)
  })

  it('aggregates bad-summary signals including the unsummarizable marker', async () => {
    wireQueries({ bad: { too_short: '3', unsummarizable: '2', any_bad: '5' } })
    const h = await getHealth()
    expect(h.badSummaryTotal).toBe(5)
    expect(h.badSummaryByCategory.too_short).toBe(3)
    expect(h.badSummaryByCategory.unsummarizable).toBe(2)
  })

  it('passes the configured collection names to embedding queries', async () => {
    wireQueries({})
    await getHealth()
    const embeddingCall = query.mock.calls.find(([sql]) => String(sql).includes('pending_msgs'))
    expect(embeddingCall?.[1]).toEqual(['convo-sessions', 'convo-messages'])
  })

  it('surfaces null embedding ages when a collection is empty', async () => {
    wireQueries({ embeddings: { sessions_age_s: null, messages_age_s: '30', pending_msgs: '0' } })
    const h = await getHealth()
    expect(h.sessionEmbeddingAgeSeconds).toBeNull()
    expect(h.messageEmbeddingAgeSeconds).toBe(30)
  })
})

describe('formatHealth', () => {
  it('renders coverage, bad-summary breakdown, and embedding ages', async () => {
    wireQueries({
      coverage: { total: '100', summarized: '75', null_backlog: '25' },
      bad: { too_short: '4', any_bad: '4' },
      embeddings: { sessions_age_s: '7200', messages_age_s: null, pending_msgs: '12' },
    })
    const text = formatHealth(await getHealth())
    expect(text).toContain('Coverage: 75.0%')
    expect(text).toContain('too_short: 4')
    expect(text).toContain('2h ago')
    expect(text).toContain('never (no embeddings)')
    expect(text).toContain('Pending message embeddings: 12')
  })

  it('shows (none) when there are no bad summaries', async () => {
    wireQueries({})
    const text = formatHealth(await getHealth())
    expect(text).toContain('(none)')
  })
})
