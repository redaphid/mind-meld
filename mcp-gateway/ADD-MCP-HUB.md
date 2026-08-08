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
claude.ai ──OAuth 2.1──> <gateway-host>/mcp/metamcp
                             │
                             │  CF-Access-Client-Id / -Secret  (service token)
                             ▼
                    metamcp.<domain>/mcp        [Cloudflare Access, Service Auth]
                             │  tunnel
                             ▼
                    127.0.0.1:12010             [the hub's nginx edge]
                             │  X-API-Key injected here, never leaves the box
                             ▼
                    MetaMCP  ──> every upstream MCP server
```

The service name **is** the subdomain. `MCP_SERVICES` gains `metamcp`, and
`/mcp/metamcp` therefore proxies to `https://metamcp.<domain>/mcp`. Nothing
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
  calling `metamcp.<domain>` is the Worker, not a browser. It authenticates
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
can do them. On this account both objects already exist — step 2's Access
application was created before the hostname was published (the safe order), and
step 3's tunnel rule exists but points at the wrong port — so read them as
"verify, then correct", not "create".

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

`MCP_SERVICES` in `wrangler.jsonc` already lists `metamcp`. One command:

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

### 2. Verify the Access application — **before** step 3

**This application already exists** on this account; it was created for the
hub's hostname before the tunnel was published, which is the right order.
Between a tunnel hostname existing and an Access app covering it, the hub is
open to the internet — and because Access apps can be created for a hostname
that does not resolve yet, that window can simply be skipped. So this step is
now a *check*, not a creation. If you are following this runbook for a
different service, create the app with exactly these settings first.

Zero Trust dashboard → **Access → Applications** → open the app for
`metamcp.<domain>` (create it via **Add an application → Self-hosted** if it is
missing) and confirm:

- **Public hostname**: subdomain `metamcp`, domain `<domain>`, **path empty**.
  The path field must be blank — the whole hostname, not just `/mcp`. See the
  risk note below: the hub's edge serves the MetaMCP **admin UI** at `/`, so a
  path-scoped app protects the tool endpoint and leaves the admin UI open.
- **A policy with action `Service Auth`**, whose **Include** is
  `Service Token` → the same token the gateway already uses for your other
  origins (its client id is `CF_ACCESS_CLIENT_ID`). A user/identity policy is
  not enough; see the note above about `502 origin_access_denied`.
- Session duration and identity providers can stay at their defaults; no human
  logs in here.

That Service Auth policy is the only one the gateway needs. **There must be no
"Allow everyone" or Bypass policy on this app** — not even for
`/.well-known/*`. The gateway serves OAuth discovery itself, so unlike a direct
claude.ai → hub connection, nothing here needs an unauthenticated path.

If you also want to open the MetaMCP admin UI in a browser at this hostname,
add a *second* policy with action `Allow` and an `Emails` include naming
yourself — understand that this widens the hostname from "one machine
credential" to "one machine credential plus anyone who can pass that identity
check", and that the admin UI is reachable at `/` there.

A one-command check that the app is live and covering the root:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://metamcp.<domain>/
# -> 302 (to <team>.cloudflareaccess.com). A 200 is the admin UI, unprotected.
```

### 3. Publish the tunnel hostname — pointed at the **edge**

Zero Trust dashboard → **Networks → Tunnels → `<tunnel>` → Configure →
Public Hostname**. A rule for this hostname may already exist (it does on this
account); **edit it** rather than adding a second one. Either way the values
are:

- **Subdomain**: `metamcp`
- **Domain**: `<domain>`
- **Path**: empty
- **Type**: `HTTP`
- **URL**: `127.0.0.1:12010`

Saving this creates the proxied DNS record if it does not exist yet.

Two ways to get the URL wrong, both of which have already happened here:

> **The port is `12010`, the edge — never `12008`, MetaMCP itself.** MetaMCP
> has no `/mcp` route (it serves `/metamcp/<endpoint>/mcp`), so a tunnel
> pointed at `12008` answers the gateway's proxied `GET/POST /mcp` with a
> **307**, not an MCP response, and the connector fails. `12008` also serves
> MetaMCP's own RFC 9728 document naming *itself* — on `localhost` — as the
> authorization server, which is the precise failure the edge was built to
> prevent. The edge is what turns `/mcp` into the curated endpoint and serves
> the correct metadata.

> **Use `127.0.0.1`, not `localhost`.** `cloudflared` here runs as a container
> with host networking, and in that namespace `localhost` resolves to `::1`
> first. The edge publishes on IPv4 loopback only (`127.0.0.1:12010->12010`),
> so `localhost:12010` is refused while `127.0.0.1:12010` works — confirmed by
> `curl` against `[::1]:12010` (connection refused) versus `127.0.0.1:12010`
> (200), and visible in the tunnel's own log as
> `dial tcp [::1]:<port>: connect: connection refused` for a neighbouring
> IPv4-only origin.

### 4. Verify

Each command with the output that means "this step is right".

```bash
# The gateway advertises the new resource
curl -s https://<gateway-host>/.well-known/oauth-protected-resource/mcp/metamcp
# -> {"resource":"https://<gateway-host>/mcp/metamcp",
#     "authorization_servers":["https://<gateway-host>"], ...}

# ...and challenges for it, pointing at that document
curl -si -X POST https://<gateway-host>/mcp/metamcp | grep -i www-authenticate
# -> WWW-Authenticate: Bearer realm="OAuth",
#    resource_metadata=".../.well-known/oauth-protected-resource/mcp/metamcp"

# The origin is protected: no credential gets nothing
curl -s -o /dev/null -w '%{http_code}\n' https://metamcp.<domain>/mcp
# -> 302 (to the Access login) or 403. A 200 means the hostname is UNPROTECTED:
#    remove the tunnel hostname immediately and fix the Access app.

# The origin accepts the gateway's credential
curl -s -X POST https://metamcp.<domain>/mcp \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
       "protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"probe","version":"1"}}}'
# -> event: message / data: {"result":{"protocolVersion":...,"serverInfo":{...}}}
# A login redirect here means the Service Auth policy is missing or names a
# different token. A 307 means the tunnel is pointed at MetaMCP (12008) rather
# than the edge (12010) — MetaMCP has no /mcp route. Fix step 3.

# The login gate still works (needed for the OAuth flow in step 5)
curl -si https://<gateway-host>/authorize | head -1
# -> HTTP/1.1 302, Location into <team>.cloudflareaccess.com
```

### 5. Add the connector

claude.ai → Settings → Connectors → Add custom connector →
`https://<gateway-host>/mcp/metamcp`

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
  `/` — the admin UI — unprotected. The same applies to Bypass policies: this
  route needs none, because the gateway serves OAuth discovery itself.
- **The service name must equal the hostname's first label.** The gateway
  derives the origin from the name, so renaming one without the other yields a
  `502` against a hostname that does not exist. This runbook's name changed from
  `mcp-hub` to `metamcp` for exactly that reason: the Access app was created for
  `metamcp.<domain>`, so the service is `metamcp`.
- **Adding a name to `MCP_SERVICES` also opens `/ingest/<name>`.** The same
  allowlist gates both, so `POST /ingest/metamcp` now spools into R2 under a
  `metamcp/` prefix that nothing drains. It is gated by the ingest Access app's
  Service Auth policy and readable only by `DRAIN_CLIENTS`, so the exposure is
  bounded to holders of a valid service token; the cost of one deciding to push
  is R2 storage nobody reclaims. Acceptable for a single-tenant account, worth
  knowing before this gateway is shared.
- **The allowlist is what stops subdomain-hopping.** `MCP_SERVICES` is why an
  authorized caller cannot aim the gateway's service token at an arbitrary
  `<anything>.<domain>`. Keep it exact.

## Rollback

Remove `metamcp` from `MCP_SERVICES` and redeploy; `/mcp/metamcp` returns
`404 unknown_service` again. To take the origin off the internet entirely,
delete the tunnel's public hostname — that is the single switch, and it leaves
the hub fully usable on loopback.
