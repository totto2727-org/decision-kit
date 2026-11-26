/* oxlint-disable rules/no-node-imports -- This test creates a private cache and invokes the real Oxlint CLI. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDecisionClient } from '@totto2727/decision-kit'
import type { DecisionError, PredicateRequest } from '@totto2727/decision-kit'
import { Effect, Predicate } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

import { requestForTestTitle } from './plugin.ts'

const prime = (
  cacheDir: string,
  request: PredicateRequest,
  probability: number,
): Effect.Effect<number, DecisionError> => {
  const client = createDecisionClient({
    cacheDir,
    fetch: vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ answers: [{ name: request.name, probability, type: 'predicate' }], model: request.model }),
      ),
    mode: 'remote',
    token: 'mock-token',
    ttlSeconds: 3600,
  })
  return client.resolve(request)
}

const primeCache = async (cacheDir: string): Promise<void> => {
  const callback = "() => assert.equal('viewer', 'viewer')"
  const preflight = Effect.all([
    prime(cacheDir, requestForTestTitle('returns the administrator role', callback), 0.01),
    prime(cacheDir, requestForTestTitle('returns the viewer role', callback), 0.99),
  ])
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Populate the private cache before starting the child process.
  await Effect.runPromise(preflight)
}

const lintExample = (cacheDir: string): unknown => {
  const localOxlint = fileURLToPath(new URL('bin/oxlint', import.meta.resolve('oxlint/package.json')))
  // oxlint-disable-next-line node/no-process-env -- Allow a caller-selected binary for the real CLI check.
  const override = process.env['OXLINT_BIN']
  const args = ['-c', 'oxlint.json', '--format=json', 'sample.js']
  const command = Predicate.isNullish(override) ? [localOxlint, ...args] : args
  // oxlint-disable-next-line node/no-sync -- Wait for the CLI's exit status and complete JSON output.
  const result = spawnSync(override ?? process.execPath, command, {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    // oxlint-disable-next-line node/no-process-env -- Preserve the host environment and supply the private fixture cache.
    env: { ...process.env, DECISION_KIT_CACHE_DIR: cacheDir },
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result).toMatchObject({ status: 0 })
  return JSON.parse(result.stdout)
}

describe('real Oxlint visitor', () => {
  test('distinguishes a low-probability decision from missing evidence', async ({ onTestFinished }) => {
    expect.hasAssertions()
    const cacheDir = await mkdtemp(Path.join(tmpdir(), 'decision-kit-oxlint-'))
    onTestFinished(async () => rm(cacheDir, { force: true, recursive: true }))
    await primeCache(cacheDir)
    expect(lintExample(cacheDir)).toMatchObject({
      diagnostics: [
        {
          labels: [{ span: { line: 3 } }],
          message: 'The cached decision suggests this test title does not describe its assertion.',
        },
        { labels: [{ span: { line: 5 } }], message: 'No usable cached test-title decision (cache-miss).' },
      ],
    })
  })
})
