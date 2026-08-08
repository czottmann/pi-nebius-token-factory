# @czottmann/pi-nebius-token-factory

Nebius Token Factory provider extension for [pi](https://pi.dev). It registers tool-capable [Nebius Token Factory](https://tokenfactory.nebius.com/) models under the `nebius-token-factory` provider.

## Install

From npm:

```bash
pi install npm:@czottmann/pi-nebius-token-factory
```

From a local checkout:

```bash
cd path/to/pi-nebius-token-factory
npm install
pi install "$PWD"
```

## Set up auth

Use pi's API-key flow:

```bash
pi
/login
# Choose "Use an API key", then "Nebius Token Factory".
```

Or set an environment variable before starting pi:

```bash
export NEBIUS_TOKEN_FACTORY_API_KEY=your-key-here
```

Nebius Token Factory currently uses static API keys. It should appear under API keys in `/login`, not under subscriptions.

## Use

List registered models:

```bash
pi --list-models | grep nebius-token-factory
```

Start pi with Nebius Token Factory:

```bash
pi --provider nebius-token-factory
```

In interactive mode, `/nebius-token-factory-models` lists the Nebius Token Factory models registered by the extension.

## How it works

The extension registers the `nebius-token-factory` provider on startup, so it appears under API keys in `/login` even before you have set a key. When `NEBIUS_TOKEN_FACTORY_API_KEY` is set, the catalog is fetched at load; otherwise the provider starts without models until you save a key in `/login`, after which pi refreshes the provider and the models appear — no restart needed.

The catalog fetch calls `GET https://api.tokenfactory.nebius.com/v1/models?verbose=true` and keeps models that support tool calling. Note that non-interactive runs (`pi --list-models`) do not refresh provider catalogs, so in those modes models are only available when `NEBIUS_TOKEN_FACTORY_API_KEY` is set.

Model metadata is derived from the Nebius Token Factory catalog:

- `context_length` becomes pi's context window.
- `pricing.prompt` and `pricing.completion` (per-token) become pi's per-million cost metadata.
- A modality with image input (e.g. `text+image->text`) adds image input support.
- The `reasoning` feature marks a model as reasoning-capable.

The catalog requires authentication: `NEBIUS_TOKEN_FACTORY_API_KEY` or a saved key from `/login` must be present for models to load. The same key is used for inference.

## Development

```bash
npm run check
npm run build
pi -e . --provider nebius-token-factory
```

## Publishing

GitHub Actions publishes the package to npm when a GitHub Release is published. The release tag must match `package.json` exactly, with or without a leading `v` (`v1.0.0` and `1.0.0` both work for version `1.0.0`).

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- My other Pi plugins: https://pi.dev/packages?name=%40czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@zottmann
