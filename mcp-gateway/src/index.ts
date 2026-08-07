// An OAuth 2.1 authorization server that fronts self-hosted MCP servers.
//
// The problem it solves: claude.ai speaks the MCP authorization spec — discover
// metadata, register dynamically, get a bearer token. Cloudflare Access speaks
// its own dialect (a `Cloudflare-Access` WWW-Authenticate challenge and a
// metadata document at a non-standard path), and it answers *every* path on a
// protected hostname with a login redirect, so the standard discovery paths
// never reach the origin at all. The two cannot meet.
//
// This gateway is the translator. It is a spec-compliant authorization server
// on the outside; on the inside it delegates the actual identity decision to
// Access and reaches origins with an Access service token. The MCP servers
// behind it need no authentication code, no OAuth awareness, and no change of
// any kind — they keep sitting behind Access exactly as before.
//
// Routing is by naming convention, so adding a server is adding a name:
//
//     https://<gateway>/mcp/<service>  ->  https://<service>.<ORIGIN_DOMAIN>/mcp
//
// with MCP_SERVICES as the allowlist of which names are real.
import OAuthProvider, {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'

export interface Env {
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers

  // Origins are <service>.<ORIGIN_DOMAIN>, e.g. "example.com".
  ORIGIN_DOMAIN: string
  // Comma-separated service names this gateway will proxy. The allowlist is
  // what stops an authenticated caller from using the gateway's service token
  // to reach arbitrary subdomains.
  MCP_SERVICES: string

  // Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com".
  ACCESS_TEAM_DOMAIN: string
  // The AUD tag of the Access application protecting /authorize. Verifying it
  // is what stops a token minted for some *other* Access app being replayed.
  ACCESS_AUD: string

  // Who may complete an authorization. Both are comma-separated and both are
  // optional individually, but with neither set the gateway denies everyone —
  // see `permitted`.
  ALLOWED_EMAILS?: string
  ALLOWED_EMAIL_DOMAINS?: string

  // Access service token, so the gateway can pass the origins' own Access
  // policies. Set as secrets, never as plaintext vars.
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
}

// Carried through the OAuth grant, encrypted at rest by the provider, and
// handed back to the API handler on every proxied request.
type Props = {
  email: string
  sub: string
}

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification
// ---------------------------------------------------------------------------
// Access injects Cf-Access-Jwt-Assertion on requests it has authenticated, and
// strips any client-supplied copy. That makes the header trustworthy *only* on
// a path Access actually protects. Since the rest of this hostname is
// deliberately bypassed so the OAuth endpoints stay reachable, a misconfigured
// or removed path policy would turn a forged header into a free pass. So the
// signature, audience and expiry are checked here rather than assumed.

const JWKS_TTL_MS = 60 * 60 * 1000

let jwksCache: { url: string; keys: Map<string, CryptoKey>; expires: number } | null = null

const accessKey = async (teamDomain: string, kid: string): Promise<CryptoKey | undefined> => {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`
  if (!jwksCache || jwksCache.url !== url || jwksCache.expires < Date.now()) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`)
    const { keys = [] } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
    const imported = new Map<string, CryptoKey>()
    for (const jwk of keys) {
      if (!jwk.kid) continue
      imported.set(
        jwk.kid,
        await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        )
      )
    }
    jwksCache = { url, keys: imported, expires: Date.now() + JWKS_TTL_MS }
  }
  return jwksCache.keys.get(kid)
}

const decodeSegment = (segment: string): Uint8Array => {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}

const decodeJson = (segment: string): any =>
  JSON.parse(new TextDecoder().decode(decodeSegment(segment)))

type AccessIdentity = { email: string; sub: string }

const verifyAccessJwt = async (token: string, env: Env): Promise<AccessIdentity | null> => {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  let header: any
  let payload: any
  try {
    header = decodeJson(parts[0])
    payload = decodeJson(parts[1])
  } catch {
    return null
  }
  if (header.alg !== 'RS256' || !header.kid) return null

  const key = await accessKey(env.ACCESS_TEAM_DOMAIN, header.kid)
  if (!key) return null

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeSegment(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  )
  if (!ok) return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp === 'number' && payload.exp < now) return null
  if (typeof payload.nbf === 'number' && payload.nbf > now) return null

  // `aud` is a string or an array of them, depending on Access's mood.
  const audience: string[] = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : []
  if (!audience.includes(env.ACCESS_AUD)) return null

  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null

  const email: string | undefined = payload.email ?? payload.identity?.email
  if (!email) return null

  return { email: String(email).toLowerCase(), sub: String(payload.sub ?? email) }
}

// Fails closed: an empty configuration permits nobody, because the failure
// mode of the alternative is publishing everything behind this gateway.
const permitted = (email: string, env: Env): boolean => {
  const emails = list(env.ALLOWED_EMAILS)
  const domains = list(env.ALLOWED_EMAIL_DOMAINS)
  if (emails.length === 0 && domains.length === 0) return false
  if (emails.includes(email)) return true
  const domain = email.split('@')[1] ?? ''
  return domains.includes(domain)
}

// ---------------------------------------------------------------------------
// The browser-facing half: /authorize
// ---------------------------------------------------------------------------

const page = (title: string, body: string, status: number): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;` +
      `color:#e8e8ea;background:#16161a}h1{font-size:1.3rem;margin:0 0 .6rem}p{color:#a9a9b3;margin:.4rem 0}` +
      `code{background:#26262c;padding:.15em .4em;border-radius:4px;font-size:.9em}</style>` +
      `<h1>${title}</h1>${body}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  )

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname !== '/authorize') {
      // Deliberately says nothing about which services exist: this hostname is
      // reachable without Access so that the OAuth endpoints work, and the set
      // of a person's private MCP servers is itself worth not publishing.
      return page(
        'MCP gateway',
        `<p>An OAuth 2.1 authorization server for MCP clients.</p>` +
          `<p>Point your client at <code>/mcp/&lt;service&gt;</code>.</p>`,
        404
      )
    }

    // Parse before authenticating: a malformed request should fail as an OAuth
    // error to the client rather than bouncing a human through a login first.
    let authRequest: AuthRequest
    try {
      authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request)
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error
      if (!error.redirectUri) return page('Invalid request', `<p>${error.description}</p>`, 400)
      const back = new URL(error.redirectUri)
      back.searchParams.set('error', error.code)
      back.searchParams.set('error_description', error.description)
      if (error.state) back.searchParams.set('state', error.state)
      if (error.issuer) back.searchParams.set('iss', error.issuer)
      return Response.redirect(back.toString(), 302)
    }

    const jwt =
      request.headers.get('Cf-Access-Jwt-Assertion') ??
      /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1]

    if (!jwt) {
      return page(
        'Not signed in',
        `<p>This endpoint must be reached through Cloudflare Access, and no Access ` +
          `assertion was present.</p><p>If you are seeing this after signing in, the ` +
          `Access application protecting <code>/authorize</code> is missing or misconfigured.</p>`,
        401
      )
    }

    const identity = await verifyAccessJwt(jwt, env)
    if (!identity) return page('Not signed in', `<p>Your Access session is not valid here.</p>`, 401)

    if (!permitted(identity.email, env)) {
      return page('No access', `<p>${identity.email} is not permitted to use this gateway.</p>`, 403)
    }

    // No consent screen. Access already put a human behind a real identity
    // provider on this exact request; a second "are you sure" would add a click
    // and no security.
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: identity.sub,
      metadata: { email: identity.email },
      scope: authRequest.scope,
      props: { email: identity.email, sub: identity.sub } satisfies Props,
    })
    return Response.redirect(redirectTo, 302)
  },
}

// ---------------------------------------------------------------------------
// The MCP-facing half: /mcp/<service>
// ---------------------------------------------------------------------------

// Hop-by-hop headers belong to a single connection and must not be relayed
// (RFC 9110 §7.6.1); the runtime frames the upstream request itself.
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The provider decrypts the grant's props and attaches them before calling
    // us; its handler signature just can't say so generically.
    const props = ctx.props as Props
    const url = new URL(request.url)
    const [service, ...rest] = url.pathname.replace(/^\/mcp\/?/, '').split('/')

    if (!service || !list(env.MCP_SERVICES).includes(service.toLowerCase())) {
      return Response.json({ error: 'unknown_service' }, { status: 404 })
    }

    const target = new URL(`https://${service}.${env.ORIGIN_DOMAIN}/mcp`)
    if (rest.length) target.pathname += `/${rest.join('/')}`
    target.search = url.search

    const headers = new Headers(request.headers)
    for (const h of HOP_BY_HOP) headers.delete(h)
    // Our bearer token is ours; the origin gets the service token instead.
    headers.delete('authorization')
    headers.delete('cookie')
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID)
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET)
    // Who the origin is answering for, should it ever want to know. Servers
    // that ignore it are unaffected, which is the point of this whole design.
    headers.set('X-Forwarded-Email', props.email)

    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })

    // A redirect to the Access login page means the service token was refused,
    // which is a gateway misconfiguration and not something an MCP client can
    // act on. Say so plainly instead of relaying a 302 it will never follow.
    const location = upstream.headers.get('location') ?? ''
    if (upstream.status >= 300 && upstream.status < 400 && location.includes('cloudflareaccess.com')) {
      return Response.json(
        {
          error: 'origin_access_denied',
          detail: `Cloudflare Access rejected the gateway's service token for ${service}. Add a Service Auth policy for this token to that application.`,
        },
        { status: 502 }
      )
    }

    const out = new Headers(upstream.headers)
    for (const h of HOP_BY_HOP) out.delete(h)
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}

export default new OAuthProvider<Env>({
  apiRoute: '/mcp/',
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
})
