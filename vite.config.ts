import { generateIgnorePatterns } from '@totto2727/gitignore-patterns'
import libraryPreset from '@totto2727/oxlint/preset/library'
import { defineConfig } from 'vite-plus'

const ignorePatterns = await generateIgnorePatterns(new URL('.', import.meta.url))

// oxlint-disable-next-line import/no-default-export -- Vite+ reads the default configuration export.
export default defineConfig({
  fmt: {
    arrowParens: 'always',
    experimentalSortImports: {
      ignoreCase: true,
      newlinesBetween: true,
      order: 'asc',
    },
    experimentalSortPackageJson: true,
    ignorePatterns,
    jsxSingleQuote: true,
    printWidth: 120,
    proseWrap: 'preserve',
    semi: false,
    singleQuote: true,
  },
  lint: {
    ...libraryPreset,
    env: { node: true },
    ignorePatterns: [...ignorePatterns, 'typescript/examples/oxlint/sample.js'],
    options: { ...libraryPreset.options, typeCheck: true },
  },
  pack: {
    clean: true,
    deps: { neverBundle: [/^effect(?:\/|$)/u] },
    dts: true,
    entry: ['typescript/decision-kit.ts'],
    fixedExtension: false,
    format: ['esm'],
    outDir: 'typescript/dist',
    platform: 'node',
  },
  run: {
    tasks: {
      build: {
        cache: {
          input: [{ auto: true }, '!typescript/dist/**'],
          output: ['typescript/dist/**'],
        },
        command: 'vp pack',
      },
      check: {
        command: 'vp check',
        dependsOn: ['build'],
      },
      ci: {
        command: '',
        dependsOn: ['check', 'test', 'package'],
      },
      fix: {
        command: 'vp check --fix',
      },
      package: {
        command: 'vp pm pack --pack-destination ../tmp',
        cwd: 'typescript',
        dependsOn: ['build'],
      },
      test: {
        cache: { env: ['MBTLINT_DIR', 'OXLINT_BIN'] },
        command: 'vp test run',
        dependsOn: ['build'],
      },
      'test:mbtlint': {
        cache: false,
        command: [
          'test -n "$MBTLINT_DIR" || (echo "Set MBTLINT_DIR to the local mbtlint checkout." >&2; exit 1)',
          'vp test run examples/mbtlint/interop.test.ts',
        ],
      },
      'test:oxlint': {
        cache: { env: ['OXLINT_BIN'] },
        command: 'vp test run typescript/examples/oxlint/plugin.test.ts',
        dependsOn: ['build'],
      },
    },
  },
  test: { include: ['typescript/**/*.test.ts', 'examples/**/*.test.ts'] },
})
