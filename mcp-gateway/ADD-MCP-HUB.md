# Adding a second service: the MCP hub

A worked example of the one thing this gateway is designed to make cheap —
publishing another self-hosted MCP server to claude.ai. The hub in question is
a MetaMCP aggregator that fronts several upstream servers behind one endpoint,
so a single connector carries every tool at once.

Read `README.md` first for why the gateway exists. This file is the ordered
runbook: what to run, what to click, and what to check.

> **Placeholders.** This repository is public (see the root `CLAUDE.md`), so
> every real hostname below is a stand-in. Your real values live in
> `wrangler.jsonc` (gitignored) and in the hub's own `.env`.
>
> | Placeholder | Where the real value lives |
> | --- | --- |
> | `<gateway-host>` | `routes[].pattern` in `wrangler.jsonc` |
> | `<domain>` | `vars.ORIGIN_DOMAIN` in `wrangler.jsonc` |
> | `<team>.cloudflareaccess.com` | `vars.ACCESS_TEAM_DOMAIN` in `wrangler.jsonc` |
> | `<tunnel>` | the Cloudflare tunnel already publishing your other origins |

## What is being wired

```
claude.ai ──OAuth 2.1──> <gateway-host>/mcp/mcp-hub
                             │
                             │  CF-Access-Client-Id / -Secret  (service token)
                             ▼
                    mcp-hub.<domain>/mcp        [Cloudflare Access, Service Auth]
                             │  tunnel
                             ▼
                    127.0.0.1:12010             [the hub's nginx edge]
                             │  X-API-Key injected here, never leaves the box
                             ▼
                    MetaMCP  ──> every upstream MCP server
```

The service name **is** the subdomain. `MCP_SERVICES` gains `mcp-hub`, and
`/mcp/mcp-hub` therefore proxies to `https://mcp-hub.<domain>/mcp`. Nothing
else in the Worker changes — that is the whole point of the naming convention.

## Which credential flows where

Four credentials are in play and none of them meets another. Getting this wrong
is the most common way to spend an afternoon.

| Credential | Minted by | Presented to | Never seen by |
| --- | --- | --- | --- |
| OAuth bearer token | this Worker | this Worker (`/mcp/*`) | the origin — `apiHandler` deletes `authorization` before proxying |
| Access session JWT | the Access app on `<gateway-host>/authorize` | this Worker, verified against `ACCESS_AUD` | the origin |
| **Access service token** | your Zero Trust account | the **origin's** Access app | claude.ai |
| MetaMCP API key | the hub | MetaMCP, injected by the hub's own edge | anything off the machine |

Two consequences worth stating flatly, because both are easy to get backwards:

- **The origin needs a Service Auth policy, not a user policy.** The client
  calling `mcp-hub.<domain>` is the Worker, not a browser. It authenticates
  with `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, which only a
  Service Auth policy accepts. An identity (email) policy would send it a login
  redirect, and the Worker answers that with a deliberate
  `502 origin_access_denied` rather than relaying a 302 no MCP client can follow.
- **Do not add the hub app's AUD to `ACCESS_AUD`.** `ACCESS_AUD` and
  `INGEST_ACCESS_AUD` are the audiences of Access apps protecting *this
  Worker's own* inbound paths. The hub's Access app mints a JWT for the hub,
  which the hub's edge consumes; this Worker never sees or verifies it. Adding
  it would widen what can impersonate a signed-in human at `/authorize`.

**No new secret is required.** The Worker sends the same
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` to every origin, so the hub's
policy simply includes the service token the gateway already uses.

## Runbook

Steps 2 and 3 need Cloudflare dashboard access; nobody but the account holder
can do them.

### 0. Confirm the hub's edge is up

The edge is behind a compose profile and is not started by a plain `up`:

```bash
docker compose --profile public up -d edge   # in the hub's checkout
curl -s http://127.0.0.1:12010/.well-known/oauth-protected-resource/mcp
```

Expect a JSON document whose `authorization_servers` names
`https://<team>.cloudflareaccess.com`. If this is empty, stop here — everything
downstream will 502.

### 1. Deploy the Worker

`MCP_SERVICES` in `wrangler.jsonc` already lists `mcp-hub`. One command:

```bash
cd mcp-gateway && pnpm run deploy
```

This uploads code and `vars` together. Worth knowing before you run it: if the
deployed Worker predates the multi-AUD change, this deploy also fixes
`/authorize`, which had been comparing the whole comma-separated `ACCESS_AUD`
string against a single audience. To see what you are replacing:

```bash
npx wrangler deployments list    # is the last deploy older than your edits?
```

### 2. Create the Access application — **before** step 3

Do this first. Between a tunnel hostname existing and an Access app covering
it, the hub is open to the internet; Access apps can be created for a hostname
that does not resolve yet, so the window can simply be skipped.

Zero Trust dashboard → **Access → Applications → Add an application →
Self-hosted**:

- **Application name**: anything, e.g. `mcp-hub`
- **Public hostname**: subdomain `mcp-hub`, domain `<domain>`, **path empty**
  (the whole hostname, not just `/mcp` — see the risk note below)
- Leave session duration and identity providers at their defaults; no human
  logs in here.

Then **Add a policy**:

- **Action**: `Service Auth`
- **Include**: `Service Token` → the same token the gateway already uses for
  your other origins (its client id is `CF_ACCESS_CLIENT_ID`)

That is the only policy the gateway needs. **Do not add an "Allow everyone"
or bypass policy.** If you also want to open the MetaMCP admin UI in a browser
at this hostname, add a *second* policy with action `Allow` and an
`Emails` include naming yourself — understand that this widens the hostname
from "one machine credential" to "one machine credential plus anyone who can
pass that identity check", and that the admin UI is reachable at `/` there.

### 3. Publish the tunnel hostname

Zero Trust dashboard → **Networks → Tunnels → `<tunnel>` → Configure →
Public Hostname → Add a public hostname**:

- **Subdomain**: `mcp-hub`
- **Domain**: `<domain>`
- **Path**: empty
- **Type**: `HTTP`
- **URL**: `127.0.0.1:12010`

> **Use `127.0.0.1`, not `localhost`.** `cloudflared` here runs as a container
> with `network_mode: host`, and in that namespace `localhost` resolves to `::1`
> first. The edge binds IPv4 loopback only, so `localhost:12010` is refused
> while `127.0.0.1:12010` works. Verified by running a host-network container
> against both.

Saving this creates the proxied DNS record for you.

### 4. Verify

Each command with the output that means "this step is right".

```bash
# The gateway advertises the new resource
curl -s https://<gateway-host>/.well-known/oauth-protected-resource/mcp/mcp-hub
# -> {"resource":"https://<gateway-host>/mcp/mcp-hub",
#     "authorization_servers":["https://<gateway-host>"], ...}

# ...and challenges for it, pointing at that document
curl -si -X POST https://<gateway-host>/mcp/mcp-hub | grep -i www-authenticate
# -> WWW-Authenticate: Bearer realm="OAuth",
#    resource_metadata=".../.well-known/oauth-protected-resource/mcp/mcp-hub"

# The origin is protected: no credential gets nothing
curl -s -o /dev/null -w '%{http_code}\n' https://mcp-hub.<domain>/mcp
# -> 302 (to the Access login) or 403. A 200 means the hostname is UNPROTECTED:
#    remove the tunnel hostname immediately and fix the Access app.

# The origin accepts the gateway's credential
curl -s -X POST https://mcp-hub.<domain>/mcp \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
       "protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"probe","version":"1"}}}'
# -> event: message / data: {"result":{"protocolVersion":...,"serverInfo":{...}}}
# A login redirect here means the Service Auth policy is missing or names a
# different token.

# The login gate still works (needed for the OAuth flow in step 5)
curl -si https://<gateway-host>/authorize | head -1
# -> HTTP/1.1 302, Location into <team>.cloudflareaccess.com
```

### 5. Add the connector

claude.ai → Settings → Connectors → Add custom connector →
`https://<gateway-host>/mcp/mcp-hub`

Discovery, dynamic registration and the Access-backed login follow from there.
If registration fails, the gateway hostname's bypass policy is the thing to
check — `/register` and `/token` must be publicly reachable.

## Risks and side effects

- **The hub's edge has no authentication of its own.** It answers `initialize`
  on loopback with no credential at all, and its catch-all `location /` proxies
  the MetaMCP **admin UI**. Cloudflare Access is the only thing standing between
  that hostname and the internet. Publishing the tunnel hostname without the
  Access app in place exposes the admin UI and every tool behind it — lights,
  music, and a personal conversation index. This is why step 2 precedes step 3.
- **Access must cover the whole hostname, not `/mcp`.** A path-scoped app leaves
  `/` — the admin UI — unprotected.
- **Adding a name to `MCP_SERVICES` also opens `/ingest/<name>`.** The same
  allowlist gates both, so `POST /ingest/mcp-hub` now spools into R2 under an
  `mcp-hub/` prefix that nothing drains. It is gated by the ingest Access app's
  Service Auth policy and readable only by `DRAIN_CLIENTS`, so the exposure is
  bounded to holders of a valid service token; the cost of one deciding to push
  is R2 storage nobody reclaims. Acceptable for a single-tenant account, worth
  knowing before this gateway is shared.
- **The allowlist is what stops subdomain-hopping.** `MCP_SERVICES` is why an
  authorized caller cannot aim the gateway's service token at an arbitrary
  `<anything>.<domain>`. Keep it exact.

## Rollback

Remove `mcp-hub` from `MCP_SERVICES` and redeploy; `/mcp/mcp-hub` returns
`404 unknown_service` again. To take the origin off the internet entirely,
delete the tunnel's public hostname — that is the single switch, and it leaves
the hub fully usable on loopback.
