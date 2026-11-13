import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveBenchDir } from './dir.js'

const repo = path.resolve('/tmp/repo-wobbly-heron')

const errorOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e as Error
  }
  return null
}

describe('resolveBenchDir', () => {
  it('refuses to default', () => {
    expect(errorOf(() => resolveBenchDir(undefined, repo))?.message).toMatch(/no default/)
  })

  it('refuses a directory inside the repository', () => {
    expect(errorOf(() => resolveBenchDir(path.join(repo, 'bench'), repo))?.message).toMatch(/inside the repository/)
  })

  it('refuses the repository root itself', () => {
    expect(errorOf(() => resolveBenchDir(repo, repo))).not.toBeNull()
  })

  it('accepts a sibling whose name starts like the repository', () => {
    expect(resolveBenchDir(`${repo}-bench`, repo)).toBe(`${repo}-bench`)
  })
})
