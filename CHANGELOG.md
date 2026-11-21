# Changelog

## 0.3.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0

### Changes

- HTTP: the server refuses to start without `MCP_HTTP_TOKEN` when bound to a
  non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true` (in addition to
  `HEVY_TRUST_FORWARDED_USER=true`). `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an
  explicit escape hatch for the first two cases only.
- HTTP: `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- HTTP: failed `/mcp` authentications are limited per client address (429 with
  `Retry-After`); valid tokens are never throttled. New `MCP_AUTH_FAILURE_LIMIT`
  (default 20, `0` disables) and `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- HTTP: `Host` header check on `/mcp` for loopback binds (`MCP_ALLOWED_HOSTS`).
- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON returns 400
  (JSON-RPC parse error) instead of 500; oversized bodies are refused from
  `Content-Length` before reading; one log line per rejected request.
- HTTP: graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES`, `HEVY_TIMEOUT_MS` and the boolean `MCP_*` flags
  are validated at startup; invalid values stop the server instead of becoming
  `NaN`.
- Hevy client: redirects are never followed, so the `api-key` header cannot be
  sent to another host. Error bodies are read up to 64 KB and the key is
  redacted before truncation.
- The MCP server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, patched
  transitive dependencies). CI: pinned actions, image build on pull requests,
  images published only after tests pass, with SBOM and provenance.

### Upgrade notes

- Deployments binding a non-loopback address must set `MCP_HTTP_TOKEN` (at
  least 32 characters, e.g. `openssl rand -hex 32`). A shorter token now stops
  the server.
- Invalid values for the variables above now stop the server at startup.
- Unchanged: `/healthz` and `/hevy/enroll` remain reachable without the bearer.

### Also in this release

- Security: refuse to start when `HEVY_TRUST_FORWARDED_USER=true` and `MCP_HTTP_TOKEN` is
  unset (and fail closed on `/mcp` in that case); the bearer is compared in constant time.
- Security: the enrollment page shows the gateway identity the link is bound to and
  requires an explicit, browser-bound confirmation before an API key is accepted.
- Security: caller-supplied ids are validated before being used as URL path segments.
- Update `@modelcontextprotocol/sdk` to 1.32.1.

## 0.1.0

Initial release. Self-hosted replacement for the public hosted Hevy MCP.

- Full read coverage: workouts, workout events (incremental sync), routines,
  routine folders, exercise templates, exercise history, user info, body
  measurements.
- Write coverage behind `HEVY_ENABLE_WRITES`: create/replace workouts and
  routines, create routine folders and custom exercise templates. Write tools
  are not registered at all when writes are disabled.
- Per-user API keys encrypted at rest (AES-256-GCM), keyed by the
  gateway-verified identity. Keys are collected through a single-use,
  state-bound browser form so a long-lived credential never enters a chat
  transcript.
- Keys are validated against Hevy during enrollment, so a bad key fails at the
  form rather than as a 401 on first use.
- Retries are GET-only: Hevy creates are not idempotent, so a retried write
  would duplicate records.
- Body measurements are deliberately read-only — Withings owns body weight and
  composition.
