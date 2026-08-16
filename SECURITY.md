# Security Policy

## Reporting A Vulnerability

Report suspected vulnerabilities privately to <security@borgels.com>.

Do not include Hevy API keys, encryption keys, or personal training data in
public GitHub issues.

## Credential Handling

Hevy API keys are long-lived, per-user credentials. They are:

- collected via a single-use, user-bound browser form — never accepted as a
  tool argument, so they don't enter conversation transcripts
- validated against Hevy before being stored
- encrypted at rest with AES-256-GCM (`HEVY_ENCRYPTION_KEY`), one row per
  gateway-verified identity
- never returned in tool output, and redacted from error messages

If a key is exposed, regenerate it at hevy.com/settings?developer — this
invalidates the old one — then reconnect via `hevy_connect`.

## Supported Versions

Security fixes target the latest `main` branch.
