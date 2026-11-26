/* oxlint-disable rules/no-node-imports -- Stage source fixtures and run the actual native MoonBit linter. */
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Path from 'node:path'

import { Effect, Predicate, String } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'

// oxlint-disable-next-line import/no-relative-parent-imports -- The example tests the SDK in this checkout.
import { createDecisionClient, predicateKey } from '../../typescript/decision-kit.ts'
// oxlint-disable-next-line import/no-relative-parent-imports -- The example tests the SDK in this checkout.
import type { PredicateRequest } from '../../typescript/decision-kit.ts'
import { runMoon, stageMoonPackage } from './moon-registry.ts'

const exampleDir = import.meta.dirname
const moonbitDir = Path.resolve(exampleDir, '../../moonbit')
const sourceName = 'sample_test.mbt'
// oxlint-disable-next-line node/no-process-env -- The sibling checkout is an explicit test prerequisite.
const mbtlintDir = process.env['MBTLINT_DIR'] ?? String.empty
const testTimeout = 120_000

const answerFor = (request: PredicateRequest, probability: number): object => {
  if (request.provider !== 'jev') {
    return { answers: [{ name: request.name, probability, type: 'predicate' }], model: request.model }
  }
  const answer = { answers: { [request.name]: { noul: probability, type: 'noul' } }, model: 'jev-1.13.0' }
  return Predicate.isNullish(request.gatewayId)
    ? answer
    : { result: { result: answer, state: 'Completed' }, success: true }
}

const prime = async (cacheDir: string, request: PredicateRequest, probability?: number): Promise<string[]> => {
  if (Predicate.isNullish(probability)) {
    return []
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(answerFor(request, probability)))
  const writer = createDecisionClient({ cacheDir, fetch, mode: 'remote', token: 'mock-token', ttlSeconds: 3600 })
  // oxlint-disable-next-line rules/no-effect-runtime-run -- Populate the private cache before starting the child process.
  await expect(Effect.runPromise(writer.resolve(request))).resolves.toBe(probability)
  expect(fetch).toHaveBeenCalledOnce()
  return [`${predicateKey(request)}.json`]
}

type Scenario = Readonly<{
  args: string[]
  name: string
  probability?: number
  request: PredicateRequest
  outcome: keyof typeof outcomes
}>

const finding = 'Review whether the test title describes the assertion.'
const outcomes = {
  finding: {
    status: 1,
    verify: ({ stdout }: ReturnType<typeof runMoon>) => {
      expect(stdout).toMatch(/sample_test\.mbt:1:\d+/u)
      expect(stdout).toContain(finding)
    },
  },
  miss: {
    status: 2,
    verify: ({ stdout, stderr }: ReturnType<typeof runMoon>) => {
      expect(stdout).not.toContain(finding)
      expect(stdout + stderr).toMatch(/CacheMiss/u)
    },
  },
  pass: {
    status: 0,
    verify: ({ stdout }: ReturnType<typeof runMoon>) => {
      expect(stdout).toBe('')
    },
  },
}

const casesFor = (input: string): Scenario[] => {
  const openAI = {
    endpoint: 'https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions',
    input,
    instructions: 'Does the test title describe its assertion?',
    model: 'gpt-6-luna',
    name: 'accurate',
    scope: 'local-demo',
  } satisfies PredicateRequest
  const jev = {
    ...openAI,
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/example/ai/run',
    gatewayId: 'team',
    model: 'typesafe/jev',
    provider: 'jev',
  } satisfies PredicateRequest
  const systemOne = {
    ...openAI,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    provider: 'jev',
  } satisfies PredicateRequest
  return [
    { args: [], name: 'openai-finding', outcome: 'finding', probability: 0.02, request: openAI },
    { args: [], name: 'openai-pass', outcome: 'pass', probability: 0.98, request: openAI },
    { args: [], name: 'openai-miss', outcome: 'miss', request: openAI },
    { args: ['--jev'], name: 'jev-finding', outcome: 'finding', probability: 0.02, request: jev },
    { args: ['--systemone'], name: 'systemone-finding', outcome: 'finding', probability: 0.02, request: systemOne },
  ]
}

const prepareWorkspace = async (cwd: string): Promise<NodeJS.ProcessEnv> => {
  const moonHome = Path.join(cwd, 'moon-home')
  const sources = ['lint.mbtx', sourceName]
  await Promise.all(sources.map(async (file) => copyFile(Path.join(exampleDir, file), Path.join(cwd, file))))
  const moduleDir = await realpath(mbtlintDir)
  await stageMoonPackage({ moduleDir, moonHome, targetDir: Path.join(cwd, 'mbtlint-package') })
  await stageMoonPackage({ moduleDir: moonbitDir, moonHome, targetDir: Path.join(cwd, 'decision-kit-package') })
  // oxlint-disable-next-line node/no-process-env -- Preserve the environment but isolate the native registry and build cache.
  return { ...process.env, MOON_HOME: moonHome, XDG_CACHE_HOME: Path.join(cwd, 'xdg-cache') }
}

const verifyScenario = async (cwd: string, env: NodeJS.ProcessEnv, scenario: Scenario): Promise<void> => {
  const { args, name, outcome, probability, request } = scenario
  const cacheDir = Path.join(cwd, name)
  await mkdir(cacheDir, { mode: 0o700 })
  const expectedFiles = await prime(cacheDir, request, probability)
  await expect(readdir(cacheDir)).resolves.toStrictEqual(expectedFiles)
  const { status, verify } = outcomes[outcome]
  const result = runMoon(['run', '--target', 'native', 'lint.mbtx', '--', sourceName, cacheDir, ...args], {
    cwd,
    env,
    status,
  })
  verify(result)
  await expect(readdir(cacheDir)).resolves.toStrictEqual(expectedFiles)
}

describe.skipIf(String.isEmpty(mbtlintDir))('native mbtlint interoperability', () => {
  test(
    'reads the Node SDK cache protocols offline',
    async ({ onTestFinished }) => {
      expect.hasAssertions()
      const cwd = await mkdtemp(Path.join(tmpdir(), 'decision-kit-mbtlint-'))
      onTestFinished(async () => rm(cwd, { force: true, recursive: true }))
      const env = await prepareWorkspace(cwd)
      const sourcePath = Path.join(cwd, sourceName)
      const source = await readFile(sourcePath, 'utf8')
      const cases = casesFor(source.replace(/\r?\n$/u, ''))
      await Promise.all(cases.map(async (scenario) => verifyScenario(cwd, env, scenario)))
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(source)
    },
    testTimeout,
  )
})
