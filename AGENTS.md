# Decision Kit development

## Repository structure

- `typescript/` is the public npm package `@totto2727/decision-kit`. The workspace root stays private.
- `moonbit/` is the native MoonBit module `totto2727/decision-kit`.
- `moonbit/fixtures/` contains shared protocol test vectors.
- `typescript/examples/oxlint/` and `examples/mbtlint/` show cache-only lint integrations.
- `vite.config.ts` defines TypeScript formatting, linting, tests, packaging, and tasks.
- `.github/workflows/ci.yml` validates the libraries independently and `.github/workflows/publish.yml` releases both packages on pushes to `main`.

## TypeScript development

Bootstrap Node.js 24 or later, Vite+, and the pnpm version from `packageManager`.
Run these commands at the repository root:

```sh
vp install --frozen-lockfile
vp run ci
```

The root Nix shell supplies nixfmt and enables local Git hooks through `vp config`.
Use `nix develop .#ci` for the hook-free shell.
Run `vp run check`, `vp run test`, `vp run build`, `vp run package`, or `vp run test:oxlint` for individual checks.
Use `vp run fix` for formatting and supported lint fixes.

Keep pnpm as the only package manager and retain the 24-hour minimum release age in strict mode.
When upgrading Vite+, update the catalog entry and both overrides to match `vp toolchain`.
Use the shared `@totto2727/oxlint` library preset, including type-aware checks.
Write TypeScript tests for the Vite+ test runner and MoonBit tests for Moon. Do not add a separate test runner or standalone JavaScript test scripts.
The Oxlint sample source is a test fixture, not SDK source, and is checked by its own plugin test.
Keep Effect external to the ESM bundle.
The SDK package exports the generated JavaScript and TypeScript declarations from `typescript/dist/`.
The TypeScript check builds the package first so the Oxlint example can resolve the public declarations.
`vp run package` creates a local archive in `tmp/` without publishing it.

## MoonBit development

Use the [MoonBit library instructions](moonbit/README.md) for module-specific commands.
The root `moon.work` selects `moonbit/`, so the template's `setup-moonbit` and `check-moonbit` actions run from the repository root with `dev-shell: moonbit-ci`.
Run module packaging and publication commands in `moonbit/`.
After public API changes, regenerate `.mbti` files with `moon info`.
Keep the shared fixtures and both bindings consistent when changing the request or cache contract.

## CI and registry policy

The TypeScript setup follows `template-vite-plus-lib`.
The MoonBit job adapts `template-moonbit-simple` to load the development shell for the nested module.
Keep both validation jobs on pull requests and pushes to `main`.
Keep both library publication jobs enabled on pushes to `main`. Do not publish from pull requests.
Configure the npm Trusted Publisher for `totto2727-org/decision-kit` and the exact workflow filename `publish.yml`; the npm job publishes only `@totto2727/decision-kit` using OIDC provenance.
The Mooncakes job uses `MOONCAKES_TOKEN` and publishes the module at `moonbit/` with the pinned MoonBit shell.
Bump the corresponding package version for each release. If npm requires a first authenticated release to register the trusted publisher, the package owner must bootstrap it.
