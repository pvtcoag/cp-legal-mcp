# Contributing to cp-legal-mcp

Thanks for your interest in improving open legal research tooling for Australia. Bug reports, new tools, jurisdiction coverage and documentation fixes are all welcome.

## Reporting issues

- **Bugs** — use the bug report template. Include the tool name, the input you sent, and what you expected versus what you got.
- **Incorrect legal results** — if a tool returns a wrong citation, misattributed holding or outdated legislation, please file it as a bug with the primary-source link. Accuracy issues are treated as high priority.
- **Feature requests** — use the feature request template and describe the research workflow you're trying to support.
- **Security vulnerabilities** — please do **not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/pvtcoag/cp-legal-mcp/security/advisories/new) instead.

Never include client-confidential or privileged information in an issue, log or test fixture.

## Development setup

See the [Quick start](README.md#quick-start) in the README. In short:

```sh
cp .env.example .env
npm ci
npm run dev
```

Before opening a pull request, make sure CI will pass locally:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep changes focused — one feature or fix per PR.
3. Add or update tests under `test/` for behaviour changes.
4. Follow the existing patterns:
   - New tools live in `src/tools/` and register through the shared helpers in `src/tools/_shared.ts` (zod input schema, annotations, `matter_ref` support).
   - Tool descriptions are read by the model — be precise about when to use the tool and what it returns.
   - Return structured errors (`upstream_unavailable`, etc.) rather than throwing to the client.
5. Update `README.md` and `CLAUDE.md` if you add, remove or rename a tool.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

## Upstream

Case law and legislation retrieval is provided by [jurisd](https://github.com/russellbrenner/jurisd). Issues with AustLII scraping or citation validation may belong upstream — if unsure, open an issue here and we'll triage it.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
