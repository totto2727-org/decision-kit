/* oxlint-disable rules/no-node-imports -- Stage archives in a private Moon registry and run the native CLI. */
import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import Path from 'node:path'

import { Data, Predicate, Result, Schema } from 'effect'

const MoonModule = Schema.Struct({
  name: Schema.String,
  source: Schema.Struct({ kind: Schema.String }),
  version: Schema.String,
})
const MoonTree = Schema.Struct({
  edges: Schema.Array(Schema.Struct({ from: Schema.Int, name: Schema.String, to: Schema.Int })),
  modules: Schema.Array(MoonModule),
  root: Schema.Int,
})
const decodeMoonTree = Schema.decodeResult(Schema.fromJsonString(MoonTree))
class MoonFixtureError extends Data.TaggedError('MoonFixtureError')<{ message: string }> {}

type MoonProcess = Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; status?: number }>

export const runMoon = (args: string[], { cwd, env, status = 0 }: MoonProcess): SpawnSyncReturns<string> => {
  // oxlint-disable-next-line node/no-sync -- Collect exit status and diagnostics from the native fixture process.
  const result = spawnSync('moon', args, { cwd, encoding: 'utf8', env, timeout: 120_000 })
  if (!Predicate.isNullish(result.error)) {
    throw result.error
  }
  if (result.status !== status) {
    throw new MoonFixtureError({
      message: `moon ${args.join(' ')}: expected exit ${status}, got ${result.status}\n${result.stdout}${result.stderr}`,
    })
  }
  return result
}

const moduleAt = (tree: typeof MoonTree.Type, index: number): typeof MoonModule.Type => {
  const module = tree.modules[index]
  if (Predicate.isNullish(module)) {
    throw new MoonFixtureError({ message: `Moon returned an invalid module index: ${index}` })
  }
  return module
}

const archivePath = (registry: string, name: string, version: string): string =>
  Path.join(registry, 'cache', name, `${version}.zip`)

const indexPath = (registry: string, name: string): string => Path.join(registry, 'index/user', `${name}.index`)

const copyRegistryFile = async (source: string, target: string): Promise<void> => {
  await mkdir(Path.dirname(target), { recursive: true })
  await copyFile(source, target)
}

const copyDependencies = async (tree: typeof MoonTree.Type, registry: string): Promise<void> => {
  // oxlint-disable-next-line node/no-process-env -- Read registry dependencies from the user's existing Moon cache.
  const upstream = Path.join(process.env['MOON_HOME'] ?? Path.join(homedir(), '.moon'), 'registry')
  await Promise.all(
    tree.modules
      .filter((module) => module.source.kind === 'registry')
      .map(async ({ name, version }) => {
        await copyRegistryFile(archivePath(upstream, name, version), archivePath(registry, name, version))
        await copyRegistryFile(indexPath(upstream, name), indexPath(registry, name))
      }),
  )
}

const writePackage = async (tree: typeof MoonTree.Type, registry: string, targetDir: string): Promise<void> => {
  const { name, version } = moduleAt(tree, tree.root)
  const deps = Object.fromEntries(
    tree.edges.filter(({ from }) => from === tree.root).map((edge) => [edge.name, moduleAt(tree, edge.to).version]),
  )
  const archive = await readFile(Path.join(targetDir, 'publish', `${name.replaceAll('/', '-')}-${version}.zip`))
  const stagedArchive = archivePath(registry, name, version)
  const stagedIndex = indexPath(registry, name)
  await mkdir(Path.dirname(stagedArchive), { recursive: true })
  await mkdir(Path.dirname(stagedIndex), { recursive: true })
  await writeFile(stagedArchive, archive)
  const checksum = createHash('sha256').update(archive).digest('hex')
  await writeFile(stagedIndex, `${JSON.stringify({ checksum, deps, name, version, yanked: false })}\n`)
}

export const stageMoonPackage = async ({
  moduleDir,
  moonHome,
  targetDir,
}: Readonly<{ moduleDir: string; moonHome: string; targetDir: string }>): Promise<void> => {
  runMoon(['package', '--frozen', '--target-dir', targetDir], { cwd: moduleDir })
  const tree = Result.getOrThrow(decodeMoonTree(runMoon(['tree', '--json'], { cwd: moduleDir }).stdout))
  const registry = Path.join(moonHome, 'registry')
  await copyDependencies(tree, registry)
  await writePackage(tree, registry, targetDir)
}
