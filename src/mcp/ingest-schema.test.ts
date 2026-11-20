import { beforeEach, describe, expect, it } from 'vitest'
import { IngestPayloadSchema } from './ingest-schema.js'

describe('when a snapshot has no authoritative revision', () => {
  let accepted: boolean
  beforeEach(() => {
    accepted = IngestPayloadSchema.safeParse({
      source: 'source-roaming-squid', dataClass: 'slack', mode: 'snapshot',
      project: { externalId: 'project-lair', name: 'The Lair' },
      session: { externalId: 'thread-kraken', title: 'The Kraken', startedAt: '2026-01-01T00:00:00Z' },
      messages: [],
    }).success
  })
  it('rejects it before any writes', () => { expect(accepted).toBe(false) })
})

const message = { externalId: 'message-lantern', role: 'user', content: 'A lantern', timestamp: '2026-01-01T00:00:00Z', sequenceNum: 0 }
const complete = {
  source: 'source-roaming-squid', dataClass: 'slack', mode: 'snapshot',
  snapshot: { revision: 1, complete: true },
  project: { externalId: 'project-lair', name: 'The Lair' },
  session: { externalId: 'thread-kraken', title: 'The Kraken', startedAt: '2026-01-01T00:00:00Z' },
  messages: [message],
}

describe.each([
  { snapshot: { revision: 0, complete: true } },
  { snapshot: { revision: 1.5, complete: true } },
  { snapshot: { revision: Number.MAX_SAFE_INTEGER + 1, complete: true } },
  { snapshot: { revision: 1, complete: false } },
  { dataClass: undefined },
  { session: { ...complete.session, startedAt: 'invalid' } },
  { session: { ...complete.session, endedAt: 'invalid' } },
  { messages: [{ ...message, externalId: '' }] },
  { messages: [{ ...message, sequenceNum: 2147483648 }] },
  { mode: 'append' },
  { messages: [message, { ...message, externalId: 'message-lantern\u0000', sequenceNum: 1 }] },
  { messages: [message, { ...message, externalId: 'message-kraken' }] },
  { messages: [{ ...message, sequenceNum: -1 }] },
  { messages: [{ ...message, timestamp: 'invalid' }] },
  { messages: [message, { ...message, externalId: 'message-kraken', sequenceNum: 1, timestamp: '2025-01-01T00:00:00Z' }] },
])('when a snapshot violates its completeness contract (%j)', invalid => {
  let accepted: boolean
  beforeEach(() => { accepted = IngestPayloadSchema.safeParse({ ...complete, ...invalid }).success })
  it('rejects the input', () => { expect(accepted).toBe(false) })
})

describe('when a complete chronological snapshot is provided', () => {
  let accepted: boolean
  beforeEach(() => { accepted = IngestPayloadSchema.safeParse(complete).success })
  it('accepts it', () => { expect(accepted).toBe(true) })
})
