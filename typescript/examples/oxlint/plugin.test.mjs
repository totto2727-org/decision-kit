/* oxlint-disable rules/no-node-imports -- The integration test uses the Node runner and launches a real Oxlint process. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDecisionClient } from '@totto2727/decision-kit'
import { Effect } from 'effect'

// oxlint-disable-next-line rules/consistent-import-extension -- Oxlint and Node execute this uncompiled .mjs plugin.
import { requestForTestTitle } from './plugin.mjs'

test('real Oxlint visitor distinguishes a low-probability decision from missing evidence', async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'decision-kit-oxlint-'))
  t.after(() => rmSync(cacheDir, { force: true, recursive: true }))
  const prime = createDecisionClient({
    cacheDir,
    async fetch(_url, { body }) {
      const {
        model,
        questions: [question],
        input,
      } = JSON.parse(new TextDecoder().decode(body))
      const probability = input.includes('administrator') ? 0.01 : 0.99
      return Response.json({ model, answers: [{ type: question.type, name: question.name, probability }] })
    },
    mode: 'remote',
    token: 'mock-token',
    ttlSeconds: 3600,
  })
  const requests = Effect.forEach(['administrator', 'viewer'], (role) => {
    const request = requestForTestTitle(`returns the ${role} role`, "() => assert.equal('viewer', 'viewer')")
    return prime.resolve(request)
  })
  // oxlint-disable-next-line rules/no-effect-runtime-run -- The offline fixture preflight is a process boundary.
  await Effect.runPromise(requests)

  const result = spawnSync(process.env.OXLINT_BIN ?? 'oxlint', ['-c', 'oxlint.json', '--format=json', 'sample.js'], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DECISION_KIT_CACHE_DIR: cacheDir },
  })
  if (result.error) {
    throw result.error
  }
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const { diagnostics } = JSON.parse(result.stdout)
  const actual = diagnostics.map(({ message, labels }) => [labels[0].span.line, message])
  assert.deepEqual(actual, [
    [4, 'The cached decision suggests this test title does not describe its assertion.'],
    [6, 'No usable cached test-title decision (cache-miss).'],
  ])
})
