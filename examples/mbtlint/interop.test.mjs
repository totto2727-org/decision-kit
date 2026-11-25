/* oxlint-disable rules/no-node-imports -- This test stages a local registry and runs the native MoonBit linter as a child process. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import Path from 'node:path'
import { test } from 'node:test'

import { Effect, Predicate } from 'effect'

import { createDecisionClient, predicateKey } from '../../typescript/decision-kit.ts'

const exampleDir = import.meta.dirname
const moonbitDir = Path.resolve(exampleDir, '../../moonbit')
const sourceName = 'sample_test.mbt'
const finding = 'Review whether the test title describes the assertion.'

const run = (command, args, { status = 0, ...options }) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options })
  if (result.error) {
    throw result.error
  }
  assert.equal(result.status, status, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result
}

const stageDecisionKit = (moonHome, cwd) => {
  const targetDir = Path.join(cwd, 'package')
  run('moon', ['package', '--frozen', '--target-dir', targetDir], { cwd: moonbitDir })
  const tree = JSON.parse(run('moon', ['tree', '--json'], { cwd: moonbitDir }).stdout)
  const { name, version } = tree.modules[tree.root]
  const deps = Object.fromEntries(
    tree.edges.filter(({ from }) => from === tree.root).map((edge) => [edge.name, tree.modules[edge.to].version]),
  )
  const stagedArchive = Path.join(moonHome, 'registry/cache', name, `${version}.zip`)
  const stagedIndex = Path.join(moonHome, 'registry/index/user', `${name}.index`)
  const archive = readFileSync(Path.join(targetDir, 'publish', `${name.replaceAll('/', '-')}-${version}.zip`))
  const checksum = createHash('sha256').update(archive).digest('hex')
  mkdirSync(Path.dirname(stagedArchive), { recursive: true })
  mkdirSync(Path.dirname(stagedIndex), { recursive: true })
  writeFileSync(stagedArchive, archive)
  writeFileSync(stagedIndex, `${JSON.stringify({ checksum, deps, name, version, yanked: false })}\n`)
}

const prime = async (cacheDir, request, probability, mock) => {
  if (Predicate.isNullish(probability)) {
    return []
  }
  const jevAnswer = { answers: { accurate: { noul: probability, type: 'noul' } }, model: 'jev-1.13.0' }
  const payload = request.gatewayId
    ? { result: { result: jevAnswer, state: 'Completed' }, success: true }
    : request.provider === 'jev'
      ? jevAnswer
      : { answers: [{ name: request.name, probability, type: 'predicate' }], model: request.model }
  const fetch = mock.fn(() => Promise.resolve(Response.json(payload)))
  const writer = createDecisionClient({ cacheDir, fetch, mode: 'remote', token: 'mock-token', ttlSeconds: 3600 })
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Prime the cross-process cache at the test boundary.
  assert.equal(await Effect.runPromise(writer.resolve(request)), probability)
  assert.equal(fetch.mock.callCount(), 1)
  return [`${predicateKey(request)}.json`]
}

test('the native MoonBit lint script reads both Node SDK cache protocols offline', async (t) => {
  assert.ok(process.env.MBTLINT_DIR, 'Set MBTLINT_DIR to the local mbtlint checkout.')
  const mbtlintDir = realpathSync(process.env.MBTLINT_DIR)
  const cwd = mkdtempSync(Path.join(tmpdir(), 'decision-kit-mbtlint-'))
  t.after(() => rmSync(cwd, { force: true, recursive: true }))
  const sources = ['lint.mbtx', sourceName]
  sources.forEach((file) => copyFileSync(Path.join(exampleDir, file), Path.join(cwd, file)))
  const moonHome = run('sh', ['test/prepare-script-home.sh'], { cwd: mbtlintDir }).stdout.trim()
  const fixtureRoot = Path.join(mbtlintDir, 'tmp')
  assert.equal(Path.dirname(moonHome), fixtureRoot)
  assert.match(moonHome.slice(fixtureRoot.length + 1), /^script-home\.[A-Za-z0-9]+$/u)
  t.after(() => rmSync(moonHome, { force: true, recursive: true }))
  stageDecisionKit(moonHome, cwd)

  const source = readFileSync(Path.join(cwd, sourceName), 'utf8')
  const openAI = {
    endpoint: 'https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions',
    input: source.replace(/\r?\n$/u, ''),
    instructions: 'Does the test title describe its assertion?',
    model: 'gpt-6-luna',
    name: 'accurate',
    scope: 'local-demo',
  }
  const jev = {
    ...openAI,
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/example/ai/run',
    gatewayId: 'team',
    model: 'typesafe/jev',
    provider: 'jev',
  }
  const systemOne = {
    ...openAI,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    provider: 'jev',
  }
  const lint = (cacheDir, status, request) => {
    const args = request.gatewayId ? ['--jev'] : request.provider === 'jev' ? ['--systemone'] : []
    return run('moon', ['run', '--target', 'native', 'lint.mbtx', '--', sourceName, cacheDir, ...args], {
      cwd,
      env: { ...process.env, MOON_HOME: moonHome, XDG_CACHE_HOME: Path.join(cwd, 'xdg-cache') },
      status,
    })
  }

  const cases = [
    { caseName: 'openai-finding', probability: 0.02, request: openAI, status: 1 },
    { caseName: 'openai-pass', probability: 0.98, request: openAI, status: 0 },
    { caseName: 'openai-miss', probability: null, request: openAI, status: 2 },
    { caseName: 'jev-finding', probability: 0.02, request: jev, status: 1 },
    { caseName: 'systemone-finding', probability: 0.02, request: systemOne, status: 1 },
  ]
  await Promise.all(
    cases.map(async ({ caseName, probability, request, status }) => {
      const cacheDir = Path.join(cwd, caseName)
      mkdirSync(cacheDir, { mode: 0o700 })
      const expectedFiles = await prime(cacheDir, request, probability, t.mock)
      assert.deepEqual(readdirSync(cacheDir), expectedFiles)
      const result = lint(cacheDir, status, request)
      if (status === 1) {
        assert.match(result.stdout, /sample_test\.mbt:1:\d+/u)
        assert.ok(result.stdout.includes(finding), result.stdout + result.stderr)
      } else {
        assert.ok(!result.stdout.includes(finding), result.stdout + result.stderr)
      }
      if (status === 2) {
        assert.match(result.stdout + result.stderr, /CacheMiss/u)
      }
      if (status === 0) {
        assert.equal(result.stdout, '')
      }
      assert.deepEqual(readdirSync(cacheDir), expectedFiles)
      t.diagnostic(`${caseName}: native lint exited ${status}`)
    }),
  )
  assert.equal(readFileSync(Path.join(cwd, sourceName), 'utf8'), source)
})
