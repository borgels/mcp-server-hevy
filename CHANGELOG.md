# Changelog

## Unreleased

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
