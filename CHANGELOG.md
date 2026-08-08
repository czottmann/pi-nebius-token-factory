# Changelog

## 1.0.1 - 2026-08-08

### Fixed

- Catalog fetches now have a per-attempt timeout and retry transient failures (network errors, timeouts, HTTP 429/5xx, invalid responses) with backoff. Previously a single failed fetch left the provider without models for the rest of the session.
- The last successfully loaded catalog is persisted in pi's provider store and restored at startup, so Nebius Token Factory models remain selectable even when the API is unreachable — the cached catalog is visible in the model picker immediately, while a catalog refresh is still running.
- The startup pre-fetch uses a reduced timeout/retry budget so a hanging API cannot block extension load for long.

## 1.0.0 - 2026-08-08

Initial release.

- Registers Nebius Token Factory as a pi provider, visible in `/login` even before an API key is set.
- Fetches the Nebius Token Factory model catalog at load when the environment key is set, and refreshes it after login/credential changes in interactive sessions.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `NEBIUS_TOKEN_FACTORY_API_KEY` environment variable.
- Adds `/nebius-token-factory-models` to list available Nebius Token Factory models.
