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
      },
      ci: {
        command: '',
        dependsOn: ['check', 'test', 'test:oxlint', 'package'],
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
        command: 'vp test run',
      },
      'test:oxlint': {
        command: 'node --test typescript/examples/oxlint/plugin.test.mjs',
        dependsOn: ['build'],
      },
    },
  },
  test: { include: ['typescript/**/*.test.ts'] },
})
