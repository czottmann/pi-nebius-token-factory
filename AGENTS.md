# AGENTS.md

## Project overview

This repository is `@czottmann/pi-nebius-token-factory`, a Pi extension package that registers the `nebius-token-factory` provider for the [Nebius Token Factory](https://tokenfactory.nebius.com/) API (`https://api.tokenfactory.nebius.com/v1`).

On startup the extension fetches the Nebius Token Factory model catalog, keeps the tool-capable models, and registers them with Pi using the `openai-completions` API adapter.

## Important files

- `extensions/nebius-token-factory.ts` — the extension. Fetches the catalog and registers the provider and the `/nebius-token-factory-models` command.
- `README.md` — user-facing install, auth, and usage docs.
- `CHANGELOG.md` — per-release notes, shipped in the npm package.
- `package.json` — npm package metadata, Pi manifest, scripts, peer/dev dependencies.
- `.github/workflows/publish.yml` — publishes to npm on a GitHub Release via Trusted Publishing.

## How the extension works

On load it registers the `nebius-token-factory` provider via `pi.registerProvider()` with the `openai-completions` adapter. When `NEBIUS_TOKEN_FACTORY_API_KEY` is set, it pre-fetches `GET https://api.tokenfactory.nebius.com/v1/models?verbose=true` and registers those models immediately, because pi does not refresh extension providers in non-interactive modes such as `pi --list-models`. Without a key it registers with an empty model list so the provider still appears in `/login`; a `refreshModels` callback then fetches the catalog using the effective credential (`context.credential`: a key saved via `/login` or the environment variable), which pi invokes after credential changes in interactive sessions. Model metadata is derived from the catalog: `context_length` becomes the context window, `pricing.prompt`/`pricing.completion` (per-token) become per-million cost metadata, a modality with image input adds image support, and the `reasoning` feature marks a model as reasoning-capable. The extension also registers `/nebius-token-factory-models` to list the registered models.

## Development commands

```bash
npm run check          # tsc --noEmit
npm pack --dry-run     # for package/release-sensitive changes
```

`npm run build` is an alias for `tsc --noEmit`. This package ships TypeScript source loaded by pi's jiti runtime; there is no compiled `dist/`.

## Coding conventions

- TypeScript is strict, ESM, NodeNext (`tsconfig.json`).
- Keep code simple and explicit. Avoid abstractions without multiple call sites.
- Pi core imports (`@earendil-works/*`) belong in `peerDependencies` with `"*"`; pinned development versions go in `devDependencies`. Do not add runtime dependencies.

## Packaging and releases

- The package ships the source files listed in `files` (`extensions`, `README.md`, `CHANGELOG.md`), not a build. `npm` also includes `package.json` and `LICENSE.md` automatically.
- Releases run through GitHub Releases: add a `CHANGELOG.md` entry, bump the version, commit, tag `vX.Y.Z`, and create a matching GitHub Release. `publish.yml` triggers on `release: published` and runs `npm publish --provenance` via Trusted Publishing.
- Publish a given version either manually or via a GitHub Release, never both — a duplicate publish fails.

## Git hygiene

- Check `git status --short` before committing or broad edits.
- Do not overwrite unrelated user changes.
- Commit only when explicitly asked.
