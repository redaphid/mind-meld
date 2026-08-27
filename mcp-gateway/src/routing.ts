// Which upstream service a gateway path names.
//
// This is one small rule, but it is the rule that decides where an authorized
// request gets proxied, so it lives on its own and is tested directly. It
// cannot be tested through `index.ts`: that module imports the OAuth provider,
// which imports `cloudflare:workers` and therefore only loads inside the
// Workers runtime.

export type Route = {
  /** An allowlisted service name, lowercased. */
  service: string
  /** Path segments below the origin's own `/mcp`, usually empty. */
  rest: string[]
}

/**
 * Resolve a gateway request path to the service that should answer it.
 *
 *     /mcp/<service>[/<rest>]  -> that service, named explicitly
 *     /mcp                     -> `fallback`
 *     /                        -> `fallback`
 *
 * Returns `null` when the resulting name is not in `allowed`, which the caller
 * answers with `404 unknown_service`. Two properties are deliberate:
 *
 * - **A named-but-unknown service never falls back.** `/mcp/nope` is a 404, not
 *   the default. Silently redirecting an unrecognized name to the aggregator
 *   would turn every typo into a working connection to the wrong server.
 * - **The allowlist gates `fallback` too**, so pointing DEFAULT_MCP_SERVICE at
 *   a name that is not in MCP_SERVICES reaches nothing. The allowlist stays the
 *   single answer to "which origins may this gateway's service token touch".
 *
 * `/mcp/<x>` is always read as a service name, never as a path inside the
 * default service: streamable HTTP addresses one endpoint URL, so there is
 * nothing below it to reach.
 */
export const resolveRoute = (
  pathname: string,
  allowed: string[],
  fallback: string | undefined
): Route | null => {
  const segments = pathname.split('/').filter(Boolean)
  const [named, ...rest] = segments[0] === 'mcp' ? segments.slice(1) : segments
  const service = (named ?? fallback ?? '').toLowerCase()
  if (!service || !allowed.includes(service)) return null
  return { service, rest }
}
