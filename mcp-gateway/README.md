# mcp-gateway

An OAuth 2.1 authorization server (a Cloudflare Worker) that lets MCP clients
like claude.ai connect to self-hosted MCP servers sitting behind Cloudflare
Access — without those servers gaining a single line of auth code.

## The problem

claude.ai's custom connectors speak the MCP authorization spec: fetch
`/.well-known/oauth-protected-resource`, register a client dynamically, run an
authorization-code flow, present a bearer token. Cloudflare Access speaks its
own dialect (`WWW-Authenticate: Cloudflare-Access …`) and answers **every**
path on a protected hostname with a login redirect — including the discovery
paths — so registration fails with "Couldn't register with the sign-in
service" before anything else can happen.

## The shape of the fix

```
claude.ai ── OAuth 2.1 ──> mcp-gateway (this Worker) ── Access service token ──> origin MCP server
                              │
                              └── /authorize sits behind Cloudflare Access,
                                  which is where the human actually logs in
```

Routing is by naming convention, so adding a server is adding a name to a list:

```
https://<gateway-host>/mcp/<service>   ->   https://<service>.<ORIGIN_DOMAIN>/mcp
```

`MCP_SERVICES` is the allowlist of which names are real. Origins keep their
Access protection and need no changes; the gateway authenticates to them with
an Access **service token**, and forwards the authorized user's email as
`X-Forwarded-Email` for any origin that cares.

Security decisions worth knowing before touching this:

- **`/authorize` trusts Access, but verifies it** — signature, `aud`, expiry
  and issuer of the `Cf-Access-Jwt-Assertion` JWT, against the team's JWKS.
  The rest of the hostname is deliberately Access-bypassed (the OAuth
  endpoints must be publicly reachable), so a forged header has to be assumed.
- **The email allowlist fails closed.** `ALLOWED_EMAILS` /
  `ALLOWED_EMAIL_DOMAINS` both empty means nobody authorizes, because the
  failure mode of the alternative is publishing everything behind the gateway.
- **The gateway's bearer token never reaches an origin**, and the service
  token never reaches a client. Each side sees only its own credential.

## Deploying

```bash
pnpm install
cp wrangler.example.jsonc wrangler.jsonc   # fill in real values (gitignored)
npx wrangler login
pnpm run deploy
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Cloudflare-side setup (dashboard or API), once per gateway:

1. A KV namespace, bound as `OAUTH_KV`.
2. An Access **service token**; its id/secret become the two secrets above.
3. An Access app on `<gateway-host>/authorize` with your normal allow policy —
   this is the login gate. Its AUD tag is `ACCESS_AUD`.
4. An Access app on `<gateway-host>` with a bypass-everyone policy, so
   discovery, `/register` and `/token` are reachable. The path-specific app
   from step 3 wins over this one where they overlap.
5. On each origin's Access app: a Service Auth policy including the token from
   step 2.

Then in claude.ai: Settings → Connectors → Add custom connector →
`https://<gateway-host>/mcp/<service>`. Discovery, registration and the
Access-backed login all follow from there.

## The ingest spool

Push ingestion (`POST /api/ingest` on an origin) had one data-loss window
file sync never had: a producer that fires once at a dead origin has nowhere
durable to put the conversation. The gateway closes it:

```
producer ── POST /ingest/<service> ──> R2 spool ── drained by ──> origin's sync loop
```

- `POST /ingest/<service>` validates against the origin repo's own Zod schema
  (`src/mcp/ingest-schema.ts` — one definition, both sides) and spools the raw
  payload into R2. `202` means accepted for processing; semantic errors the
  edge cannot see (a new source without a `dataClass`) surface at drain time
  in the origin's `sync_quarantine`.
- `GET /ingest/<service>/spool`, `GET`/`DELETE `
  `/ingest/<service>/spool/<id>` are the drain the host's sync pass uses
  (`src/sync/ingest-spool.ts` in this repo).

The whole `/ingest` path sits behind its own Access app with a Service Auth
policy: any valid service token may push, but only the client ids named in
`DRAIN_CLIENTS` may read the spool back — spooled payloads are conversation
content. The host configures `INGEST_SPOOL_URL` / `INGEST_SPOOL_CLIENT_ID` /
`INGEST_SPOOL_CLIENT_SECRET` (see `.env.example`).

## Verifying

```bash
H=https://<gateway-host>
curl $H/.well-known/oauth-protected-resource/mcp/<service>   # 200, JSON
curl $H/.well-known/oauth-authorization-server               # 200, JSON
curl -X POST $H/mcp/<service>                                # 401 + WWW-Authenticate: Bearer
curl -i $H/authorize                                         # 302 into your Access login
```
