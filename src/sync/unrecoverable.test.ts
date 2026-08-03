import { describe, it, expect } from 'vitest'
import { unrecoverableReason } from './quarantine.js'

const NUL = String.fromCharCode(0)
const NEWLINE = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

// On 2026-07-19 an unclean shutdown left five subagent transcripts with a
// NUL-padded final line: the filesystem had extended each file's recorded
// length but never flushed the data blocks. Each replayed identically forever,
// pinning `quarantined` above zero - the one number CLAUDE.md says to alert on.
describe('unrecoverableReason', () => {
  describe('when the payload is nothing but NULs', () => {
    it('calls it unrecoverable and says how many', () => {
      const reason = unrecoverableReason(NUL.repeat(2310))
      expect(reason).toContain('unrecoverable')
      expect(reason).toContain('2310')
    })

    it('tolerates the trailing whitespace a line split can leave', () => {
      expect(unrecoverableReason(NUL.repeat(10) + NEWLINE)).not.toBeNull()
      expect(unrecoverableReason(' ' + NUL.repeat(4) + TAB)).not.toBeNull()
    })
  })

  // The dangerous direction. A record that merely CONTAINS a NUL may still hold
  // a recoverable message, and parking it as unrecoverable would drop real data
  // while reporting success - the exact failure the quarantine exists to prevent.
  describe('when the payload has any real content', () => {
    it('leaves a record with an embedded NUL alone', () => {
      expect(unrecoverableReason('{"text":"a' + NUL + 'b"}')).toBeNull()
    })

    it('leaves a NUL-prefixed but otherwise real record alone', () => {
      expect(unrecoverableReason(NUL.repeat(500) + '{"uuid":"x"}')).toBeNull()
    })

    it('leaves an ordinary record alone', () => {
      expect(unrecoverableReason('{"uuid":"x"}')).toBeNull()
    })
  })

  describe('when there is no payload at all', () => {
    // Empty is a different fault with a different fix, so it keeps the generic
    // path rather than being mislabelled as an unflushed write.
    it('does not claim an unflushed write', () => {
      expect(unrecoverableReason('')).toBeNull()
      expect(unrecoverableReason('   ')).toBeNull()
    })
  })
})
