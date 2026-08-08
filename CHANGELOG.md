# Changelog

## 1.0.0 - 2026-08-08

Initial release.

- Registers Nebius Token Factory as a pi provider, visible in `/login` even before an API key is set.
- Fetches the Nebius Token Factory model catalog at load when the environment key is set, and refreshes it after login/credential changes in interactive sessions.
- Registers tool-capable models with context, pricing, image, and reasoning metadata.
- Supports pi's API-key login flow and the `NEBIUS_TOKEN_FACTORY_API_KEY` environment variable.
- Adds `/nebius-token-factory-models` to list available Nebius Token Factory models.
