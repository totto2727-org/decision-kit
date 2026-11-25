# Decision Kit development

## Repository structure

- `typescript/` is the private ESM package `@totto2727/decision-kit`.
- `moonbit/` is the native MoonBit module `totto2727/decision-kit`.
- `fixtures/` contains shared protocol test vectors.
- `typescript/examples/oxlint/` and `examples/mbtlint/` show cache-only lint integrations.
- `vite.config.ts` defines TypeScript formatting, linting, tests, packaging, and tasks.
- `.github/workflows/ci.yml` validates the libraries independently and does not publish them.

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
The Oxlint sample source is a test fixture, not SDK source, and is checked by its own plugin test.
Keep Effect external to the ESM bundle.
The SDK package exports the generated JavaScript and TypeScript declarations from `typescript/dist/`.
`vp run package` creates a local archive in `tmp/` without publishing it.

## MoonBit development

Use the [MoonBit library instructions](moonbit/README.md) for module-specific commands.
Run MoonBit commands in `moonbit/`, not at the repository root.
After public API changes, regenerate `.mbti` files with `moon info`.
Keep the shared fixtures and both bindings consistent when changing the request or cache contract.

## CI and registry policy

The TypeScript setup follows `template-vite-plus-lib`.
The MoonBit job adapts `template-moonbit-simple` to load the development shell for the nested module.
Keep both validation jobs on pull requests and pushes to `main`.
Keep the TypeScript package private and do not add registry publication workflows without explicit authorization.
