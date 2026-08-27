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
//
// One name is special. An aggregator already fronts every upstream server
// behind a single endpoint, so making a client name it twice — once as the
// gateway, once as the service — is ceremony with no meaning. DEFAULT_MCP_SERVICE
// is the service an unqualified path resolves to, which makes the endpoint the
// bare hostname:
//
//     https://<gateway>/mcp   ->  https://<DEFAULT_MCP_SERVICE>.<ORIGIN_DOMAIN>/mcp
//     https://<gateway>/      ->  the same
//
// The explicit `/mcp/<service>` form keeps working unchanged; it is how you
// reach anything that is not the default. The default is resolved against the
// same MCP_SERVICES allowlist as any other name, so it cannot widen what the
// gateway will reach; leaving it unset simply makes the unqualified URLs a 404,
// which is what they did before.
//
// Discovery follows the URL rather than being configured: the OAuth provider
// derives each RFC 9728 document from the path it was asked about
// (/.well-known/oauth-protected-resource/mcp describes https://<gateway>/mcp),
// and the 401 challenge points at the document for the path the client actually
// called. So all three URLs above self-describe correctly, and no `resource`
// value has to be kept in step by hand.
import OAuthProvider, {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
// The same repo's schema for POST /api/ingest — the acceptor validates with
// the exact definition the host enforces at drain time (see ingest-schema.ts
// for why it lives apart from the ingest logic).
import { IngestPayloadSchema } from '../../src/mcp/ingest-schema'
// The path -> service rule, kept apart so it can be tested without the Workers
// runtime. See routing.ts for why a named-but-unknown service never falls back.
import { resolveRoute } from './routing'

export interface Env {
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers
  // Durable spool for pushed conversations (see the /ingest routes): payloads
  // are accepted at the edge and drained by the host's sync loop, so a
  // producer never loses data to the origin being down.
  INGEST_SPOOL: R2Bucket

  // Origins are <service>.<ORIGIN_DOMAIN>, e.g. "example.com".
  ORIGIN_DOMAIN: string
  // Comma-separated service names this gateway will proxy. The allowlist is
  // what stops an authenticated caller from using the gateway's service token
  // to reach arbitrary subdomains.
  MCP_SERVICES: string
  // The service that answers the unqualified endpoints, `/mcp` and `/`. Must
  // also appear in MCP_SERVICES — it is a shortcut to one of those names, not a
  // second way to name an origin. Unset means the unqualified endpoints 404.
  DEFAULT_MCP_SERVICE?: string

  // Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com".
  ACCESS_TEAM_DOMAIN: string
  // AUD tag(s) of the Access application(s) protecting /authorize, comma-
  // separated — one per hostname this Worker serves, since Access apps are
  // per-hostname. Verifying the AUD is what stops a token minted for some
  // *other* Access app being replayed.
  ACCESS_AUD: string
  // AUD tag(s) of the Access application(s) protecting /ingest — separate
  // apps because their policy is Service Auth (machines), not identity
  // (humans). Comma-separated like ACCESS_AUD.
  INGEST_ACCESS_AUD: string
  // Service-token client ids allowed to read and acknowledge the spool
  // (comma-separated). Empty or unset means any valid service token may
  // drain; set it, because spooled payloads are conversation content.
  DRAIN_CLIENTS?: string

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

// A human (email, from an identity policy) or a machine (commonName, the
// service-token client id from a Service Auth policy) — Access signs both
// shapes with the same keys, distinguished by which claims are present.
type AccessIdentity = { email?: string; sub: string; commonName?: string }

const verifyAccessJwt = async (
  token: string,
  env: Env,
  // Comma-separated AUD tags; the JWT must carry one of them.
  expectedAuds: string
): Promise<AccessIdentity | null> => {
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
  if (!list(expectedAuds).some(aud => audience.includes(aud))) return null

  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null

  const email: string | undefined = payload.email ?? payload.identity?.email
  const commonName: string | undefined = payload.common_name
  if (!email && !commonName) return null

  return {
    email: email ? String(email).toLowerCase() : undefined,
    commonName: commonName ? String(commonName) : undefined,
    sub: String(payload.sub || email || commonName),
  }
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

// ---------------------------------------------------------------------------
// The producer-facing half: /ingest/<service> and its spool
// ---------------------------------------------------------------------------
// Push ingestion had one data-loss window: a producer that fires once at the
// origin and finds it down (tunnel out, host rebooting) has nowhere durable
// to put the conversation. File sync never had this problem because the files
// are the queue. These routes give push the same property: the edge accepts
// and validates the payload into R2, and the host's sync loop drains it on
// its own schedule — POST to spool, GET/DELETE under /spool to drain.
//
// Access gates the whole path with a Service Auth policy (machines, not
// humans), and the JWT is verified here for the same reason /authorize
// verifies it: the rest of the hostname is deliberately bypassed.

const INGEST_ID = /^[A-Za-z0-9.-]{1,200}$/

const handleIngest = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion')
  const identity = jwt ? await verifyAccessJwt(jwt, env, env.INGEST_ACCESS_AUD) : null
  if (!identity) {
    return Response.json(
      {
        error: 'unauthorized',
        detail:
          'Reach /ingest through Cloudflare Access with a service token (CF-Access-Client-Id / CF-Access-Client-Secret headers).',
      },
      { status: 401 }
    )
  }

  const segments = url.pathname.split('/').filter(Boolean) // ['ingest', service, 'spool'?, id?]
  const service = segments[1]?.toLowerCase()
  if (!service || !list(env.MCP_SERVICES).includes(service)) {
    return Response.json({ error: 'unknown_service' }, { status: 404 })
  }
  const prefix = `${service}/`

  // POST /ingest/<service> — validate and spool. 202 means accepted for
  // processing: schema errors are rejected here with the shared Zod schema,
  // but semantic errors the edge cannot see (a new source without a
  // dataClass) surface at drain time, in sync_quarantine.
  if (segments.length === 2 && request.method === 'POST') {
    const raw = await request.text()
    if (raw.length > 32 * 1024 * 1024) {
      return Response.json({ error: 'too_large', detail: 'Payloads are capped at 32MB.' }, { status: 413 })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const check = IngestPayloadSchema.safeParse(parsed)
    if (!check.success) {
      return Response.json(
        {
          error: 'invalid_payload',
          issues: check.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
        },
        { status: 400 }
      )
    }
    // Key order is arrival order, so a lexicographic list drains oldest-first.
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`
    await env.INGEST_SPOOL.put(prefix + id, raw, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { producer: identity.commonName ?? identity.email ?? 'unknown' },
    })
    return Response.json({ status: 'accepted', id }, { status: 202 })
  }

  // /ingest/<service>/spool[/<id>] — the host's drain. Gated separately from
  // push because these read conversation content back out: any valid service
  // token may spool, only DRAIN_CLIENTS may drain.
  if (segments[2] === 'spool') {
    const drains = list(env.DRAIN_CLIENTS)
    if (drains.length > 0 && !(identity.commonName && drains.includes(identity.commonName.toLowerCase()))) {
      return Response.json(
        { error: 'forbidden', detail: 'This credential may push but not drain.' },
        { status: 403 }
      )
    }

    if (segments.length === 3 && request.method === 'GET') {
      const listing = await env.INGEST_SPOOL.list({ prefix, limit: 100 })
      return Response.json({
        keys: listing.objects.map(o => ({
          id: o.key.slice(prefix.length),
          size: o.size,
          uploaded: o.uploaded.toISOString(),
        })),
        truncated: listing.truncated,
      })
    }

    const id = segments[3]
    if (segments.length === 4 && id && INGEST_ID.test(id)) {
      if (request.method === 'GET') {
        const obj = await env.INGEST_SPOOL.get(prefix + id)
        if (!obj) return Response.json({ error: 'not_found' }, { status: 404 })
        return new Response(obj.body, { headers: { 'content-type': 'application/json' } })
      }
      if (request.method === 'DELETE') {
        await env.INGEST_SPOOL.delete(prefix + id)
        return new Response(null, { status: 204 })
      }
    }
  }

  return Response.json({ error: 'not_found' }, { status: 404 })
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ingest' || url.pathname.startsWith('/ingest/')) {
      return handleIngest(request, env, url)
    }

    if (url.pathname !== '/authorize') {
      // Deliberately says nothing about which services exist: this hostname is
      // reachable without Access so that the OAuth endpoints work, and the set
      // of a person's private MCP servers is itself worth not publishing.
      return page(
        'MCP gateway',
        `<p>An OAuth 2.1 authorization server for MCP clients.</p>` +
          `<p>Point your client at <code>/mcp</code>.</p>`,
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

    const identity = await verifyAccessJwt(jwt, env, env.ACCESS_AUD)
    // /authorize is for humans: a service token passing Access here would
    // still have no email, and grants are issued to people.
    if (!identity?.email)
      return page('Not signed in', `<p>Your Access session is not valid here.</p>`, 401)

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

    const route = resolveRoute(url.pathname, list(env.MCP_SERVICES), env.DEFAULT_MCP_SERVICE)
    if (!route) {
      return Response.json({ error: 'unknown_service' }, { status: 404 })
    }
    const { service, rest } = route

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
  // '/mcp' is a prefix match, so it covers /mcp and /mcp/<service> alike. '/'
  // is special-cased by the provider to the root document only, so adding it
  // publishes the bare hostname as an endpoint without swallowing /authorize,
  // /token, /register or /ingest — those keep their own paths and are matched
  // before API routes anyway. The cost is that the root no longer serves the
  // landing page: an unauthenticated GET / is now a 401 challenge.
  apiRoute: ['/mcp', '/'],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
})
