# cp-legal-mcp

[![CI](https://github.com/pvtcoag/cp-legal-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pvtcoag/cp-legal-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Open-source remote MCP server for Australian legal research. It gives Claude and other MCP clients citation-ready access to case law, legislation, corporate and regulatory data, and matter tracking, with every answer traceable to a primary source.

It wraps AustLII via the upstream [jurisd](https://github.com/russellbrenner/jurisd) MCP (formerly auslaw-mcp), [Isaacus](https://isaacus.com) for semantic reranking and extractive QA, ABR/ASIC/ACCC/ASX public data, and a Postgres matter-tracking log.

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

## Quick start

Requires Node 22+, a running [jurisd](https://github.com/russellbrenner/jurisd) instance, an Isaacus API key and (optionally) Postgres.

```sh
git clone https://github.com/pvtcoag/cp-legal-mcp.git
cd cp-legal-mcp
cp .env.example .env   # fill in the required values
npm ci
npm run dev            # tsx watch on http://localhost:8080
```

Then point an MCP client at `http://localhost:8080/mcp`, e.g. in Claude Desktop via `npx mcp-remote http://localhost:8080/mcp`.

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm start
```

## Deploy

Any Docker host works. The reference deployment uses Railway, which builds from the Dockerfile (multi-stage, Node 22 alpine, non-root `nodejs` user, `HEALTHCHECK` against `/mcp/health`). `railway.toml` pins the build+start commands. Push to `main` triggers a deploy.

## Endpoints

- `POST /mcp` — MCP Streamable HTTP
- `/mcp/health` — liveness
- `/mcp/matters` — per-user matter history UI
- `/mcp/admin` — admin UI (restricted)
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` — OAuth discovery
- `/oauth/authorize`, `/oauth/token`, `/oauth/register` — OAuth flow

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is a research tool, not legal advice. Always verify results against the primary source before relying on them.

## License

Copyright 2026 pvtcoag. Licensed under the [Apache License 2.0](LICENSE).
