import { describe, expect, it } from 'vitest'
import { resolveRoute } from './routing'

// Placeholder service names — this repo is public (see the root CLAUDE.md), and
// the set of a person's private MCP servers is exactly the sort of thing not to
// publish. The rule under test does not care what the names are.
const allowed = ['notes', 'hub']
const fallback = 'hub'

describe('resolveRoute', () => {
  it('routes an explicitly named service', () => {
    expect(resolveRoute('/mcp/notes', allowed, fallback)).toEqual({ service: 'notes', rest: [] })
  })

  it('keeps any path below the service name', () => {
    expect(resolveRoute('/mcp/notes/sse', allowed, fallback)).toEqual({
      service: 'notes',
      rest: ['sse'],
    })
  })

  it('resolves the unqualified /mcp to the default service', () => {
    expect(resolveRoute('/mcp', allowed, fallback)).toEqual({ service: 'hub', rest: [] })
  })

  it('resolves the bare root to the default service', () => {
    expect(resolveRoute('/', allowed, fallback)).toEqual({ service: 'hub', rest: [] })
  })

  it('treats a trailing slash as unqualified', () => {
    expect(resolveRoute('/mcp/', allowed, fallback)).toEqual({ service: 'hub', rest: [] })
  })

  it('is case-insensitive about the name', () => {
    expect(resolveRoute('/mcp/NOTES', allowed, fallback)?.service).toBe('notes')
  })

  // The security-relevant half: the allowlist is the only thing standing
  // between an authorized caller and an arbitrary <name>.<ORIGIN_DOMAIN>.
  it('refuses a service that is not allowlisted', () => {
    expect(resolveRoute('/mcp/elsewhere', allowed, fallback)).toBeNull()
  })

  it('does NOT fall back to the default when a name was given but is unknown', () => {
    // A typo must fail visibly rather than silently connecting to the default.
    expect(resolveRoute('/mcp/notez', allowed, fallback)).toBeNull()
  })

  it('refuses a default that is not itself allowlisted', () => {
    expect(resolveRoute('/mcp', allowed, 'unlisted')).toBeNull()
    expect(resolveRoute('/', allowed, 'unlisted')).toBeNull()
  })

  it('leaves the unqualified endpoints closed when no default is configured', () => {
    expect(resolveRoute('/mcp', allowed, undefined)).toBeNull()
    expect(resolveRoute('/', allowed, undefined)).toBeNull()
  })

  // `/mcp` is registered as a prefix route, so paths that merely start with it
  // reach this rule too.
  it('does not mistake a path that only starts with mcp for the prefix', () => {
    expect(resolveRoute('/mcpsomething', allowed, fallback)).toBeNull()
  })
})
