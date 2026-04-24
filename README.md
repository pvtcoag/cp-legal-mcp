# cp-legal-mcp

Remote MCP server for Australian legal research. Deployed at `mcp.example.com` (Railway). Wraps AustLII via an upstream MCP, Isaacus (rerank + extractive QA), ABR/ASIC/ACCC/ASX, and a Postgres matter-tracking log.

## Tools

**Case research**
- `research_cases` — natural-language search, reranked
- `search_by_citation` — resolve a neutral citation
- `find_citing_cases` — who has cited a case since
- `find_related_cases` — semantically similar cases

**Judgment analysis**
- `get_judgment` — full text
- `summarise_judgment` — structured holding/orders/facts/principles/outcome
- `ask_judgment` — extractive QA on a judgment
- `enrich_judgment` — citation network with reception sentiment
- `compare_cases` — side-by-side QA on two cases

**Legislation**
- `research_legislation`, `get_legislation`

**Classification & citation**
- `classify_legal_issue`, `format_citation`

**Entity & market data**
- `lookup_entity` (ABR), `search_regulatory_decisions` (ASIC/ACCC), `search_asx_announcements`

**Matter intelligence**
- `get_matter_history`, `build_chronology`, `draft_research_memo`, `monitor_precedents`

**Time-critical**
- `check_deadlines`

**Admin** (restricted to `ADMIN_USERS`)
- `inspect_database`

See [CLAUDE.md](CLAUDE.md) for workflow guidance and tool-selection matrix.

## Architecture

- TypeScript, Node 22, Express 5, `@modelcontextprotocol/sdk` Streamable HTTP transport
- Stateful sessions keyed by `Mcp-Session-Id` (8 h idle TTL, 15 min cleanup)
- OAuth 2.1 Authorization Code + PKCE, RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, RFC 7591 dynamic client registration
- Postgres matter-query log with session-scoped matter inference
- AES-256-GCM at rest for API tokens; scrypt for password hashing

## Environment

See [.env.example](.env.example). Required:

- `ISAACUS_API_KEY`
- `DATABASE_URL` (Postgres)
- `AUSLAW_BASE_URL` (+ `AUSLAW_OAUTH_TOKEN` or client-credential vars)
- `OAUTH_ISSUER`, `OAUTH_CLIENT_SECRET`, `ENCRYPTION_KEY` (32 bytes, base64)
- `ADMIN_USERS` (comma-separated emails)

Optional: `DEBUG_SECRET`, `RECOVERY_TOKEN`, `ABR_GUID`, `DEFAULT_MATTER_REF`, `GEO_CACHE_MAX`.

## Development

```sh
npm install
npm run dev       # tsx watch
npm run typecheck
npm run build
npm start
```

## Deploy

Railway builds from the Dockerfile (multi-stage, Node 22 alpine, non-root `nodejs` user, `HEALTHCHECK` against `/auslaw/health`). `railway.toml` pins the build+start commands. Push to `main` triggers a deploy.

Each MCP now runs on its own subdomain under `example.com` (e.g. `mcp.example.com`, `other.example.com`) — the legacy Cloudflare Worker that fronted `mcp.example.com/<slug>` is no longer in use. Route the subdomain directly at the Railway service.

## Endpoints

- `POST /auslaw/mcp` — MCP Streamable HTTP
- `/auslaw/health` — liveness
- `/auslaw/matters` — per-user matter history UI
- `/auslaw/admin` — admin UI (restricted)
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` — OAuth discovery
- `/oauth/authorize`, `/oauth/token`, `/oauth/register` — OAuth flow
