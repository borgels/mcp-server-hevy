# mcp-server-hevy

MCP server for the [Hevy](https://hevy.com) strength-training API — workouts,
routines, exercise history and progression data.

Self-hosted alternative to the public hosted Hevy MCP, built to the same shape
as our other personal connectors: one shared instance, per-user credentials
encrypted at rest, access gated by the identity the gateway verifies.

Independent, unofficial project. Not affiliated with Hevy.

## Requirements

**Hevy Pro.** The Hevy developer API is only available to Pro subscribers — the
API key simply doesn't exist on a free account, so nothing here will work
without one.

## How a user links their account

The key never passes through the conversation. Instead:

1. Ask Claude to connect Hevy → `hevy_connect` returns a one-time link
2. Open it, paste the Hevy API key into the form, submit
3. The server validates it against Hevy before storing it, so a wrong key fails
   immediately rather than as a confusing 401 later

The key is found at **hevy.com/settings?developer** — in a *browser*, not the
mobile app.

This mirrors `mcp-server-garmin`: the enrollment route is reached directly
(bypassing the gateway) and is secured by a single-use, user-bound state token.
Unlike an OAuth code, a Hevy API key is long-lived, which is exactly why it
shouldn't sit in a chat transcript.

## Tools

**Auth:** `hevy_connect`, `hevy_status`, `hevy_disconnect`, `hevy_search_capabilities`

**Read:** `hevy_get_workouts`, `hevy_get_workout`, `hevy_get_workout_count`,
`hevy_get_workout_events` (incremental sync), `hevy_get_exercise_history`,
`hevy_get_routines`, `hevy_get_routine`, `hevy_get_routine_folders`,
`hevy_search_exercise_templates`, `hevy_get_exercise_template`,
`hevy_get_user_info`, `hevy_get_body_measurements`

**Write** (only registered when `HEVY_ENABLE_WRITES=true`):
`hevy_create_workout`, `hevy_update_workout`, `hevy_create_routine`,
`hevy_update_routine`, `hevy_create_routine_folder`,
`hevy_create_exercise_template`

## Hevy API constraints worth knowing

These are properties of Hevy's API, not choices made here:

- **No DELETE, no PATCH.** Nothing can be deleted through the API, and there is
  no partial update.
- **PUT replaces the whole record.** Any exercise or set omitted from an update
  is erased. Always read the current object first and resend it complete — the
  update tools are annotated `destructiveHint` for this reason.
- **Creates are not idempotent.** A retried create makes a duplicate, so this
  client retries **GET only**; failed writes surface to the caller instead of
  silently double-posting.
- **Units are fixed**: weights in kilograms, durations in seconds.
- **Small pages.** Max 10 per page for workouts/routines/folders, 100 for
  exercise templates.
- Hevy's own docs describe the API as unstable and subject to change.

## Body measurements are read-only, deliberately

Hevy can store body weight and composition, and its API can write them — this
server intentionally doesn't. **Withings is the source of truth** for body
metrics in our setup; writing them here too would create a second competing
record with no defined winner. Reading is exposed so existing Hevy data stays
visible.

## Configuration

```
HEVY_ENCRYPTION_KEY=        # AES-256-GCM key for the credential store (openssl rand -hex 32)
HEVY_STORE_PATH=/data/store.json
HEVY_PUBLIC_BASE_URL=       # public origin, used to build the enrollment link
HEVY_TRUST_FORWARDED_USER=true
HEVY_ENABLE_WRITES=true
HEVY_AUDIT_LOG=
HEVY_TIMEOUT_MS=30000
MCP_HTTP_TOKEN=
```

No app-level API credentials exist — every credential is per user.

## Verification

```
npm run typecheck && npm test && npm run build
```

## License

Apache-2.0
