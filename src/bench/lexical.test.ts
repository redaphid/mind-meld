import { describe, it, expect } from 'vitest'
import { sharedContentWords } from './lexical.js'

describe('sharedContentWords', () => {
  it('catches a reused word under a different inflection', () => {
    expect(sharedContentWords('migrating the wombat ledger', 'notes on ledger migration')).toEqual([
      'migrating',
      'ledger',
    ])
  })

  it('ignores stopwords and case', () => {
    expect(sharedContentWords('The Quokka', 'the quokka')).toEqual(['quokka'])
  })

  it('finds nothing in a true paraphrase', () => {
    expect(sharedContentWords('moving old records to the new store', 'database migration script')).toEqual([])
  })

  it('does not stem-match short words to longer ones', () => {
    expect(sharedContentWords('gpu', 'gpustat output')).toEqual([])
  })
})
