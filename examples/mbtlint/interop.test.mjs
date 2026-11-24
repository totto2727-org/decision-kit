import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDecisionClient, predicateKey } from '../../typescript/index.ts';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const moonbitDir = resolve(exampleDir, '../../moonbit');
const sourceName = 'sample_test.mbt';
const finding = 'Review whether the test title describes the assertion.';

function run(command, args, { status = 0, ...options }) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, status, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result;
}

function stageDecisionKit(moonHome, cwd) {
  const targetDir = join(cwd, 'package');
  run('moon', ['package', '--frozen', '--target-dir', targetDir], { cwd: moonbitDir });
  const tree = JSON.parse(run('moon', ['tree', '--json'], { cwd: moonbitDir }).stdout);
  const { name, version } = tree.modules[tree.root];
  const deps = Object.fromEntries(tree.edges.filter(({ from }) => from === tree.root)
    .map((edge) => [edge.name, tree.modules[edge.to].version]));
  const stagedArchive = join(moonHome, 'registry/cache', name, `${version}.zip`);
  const stagedIndex = join(moonHome, 'registry/index/user', `${name}.index`);
  const archive = readFileSync(join(targetDir, 'publish', `${name.replaceAll('/', '-')}-${version}.zip`));
  const checksum = createHash('sha256').update(archive).digest('hex');
  mkdirSync(dirname(stagedArchive), { recursive: true });
  mkdirSync(dirname(stagedIndex), { recursive: true });
  writeFileSync(stagedArchive, archive);
  writeFileSync(stagedIndex, `${JSON.stringify({ name, version, checksum, yanked: false, deps })}\n`);
}

test('the native MoonBit lint script reads the Node SDK cache offline', async (t) => {
  assert.ok(process.env.MBTLINT_DIR, 'Set MBTLINT_DIR to the local mbtlint checkout.');
  const mbtlintDir = realpathSync(process.env.MBTLINT_DIR);
  const cwd = mkdtempSync(join(tmpdir(), 'decision-kit-mbtlint-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const file of ['lint.mbtx', sourceName]) copyFileSync(join(exampleDir, file), join(cwd, file));
  const moonHome = run('sh', ['test/prepare-script-home.sh'], { cwd: mbtlintDir }).stdout.trim();
  const fixtureRoot = join(mbtlintDir, 'tmp');
  assert.equal(dirname(moonHome), fixtureRoot);
  assert.match(moonHome.slice(fixtureRoot.length + 1), /^script-home\.[A-Za-z0-9]+$/u);
  t.after(() => rmSync(moonHome, { recursive: true, force: true }));
  stageDecisionKit(moonHome, cwd);

  const source = readFileSync(join(cwd, sourceName), 'utf8');
  const request = {
    endpoint: 'https://gateway.ai.cloudflare.com/v1/example/team/openai/decisions',
    scope: 'local-demo',
    model: 'gpt-6-luna',
    name: 'accurate',
    instructions: 'Does the test title describe its assertion?',
    input: source.replace(/\r?\n$/u, ''),
  };
  const lint = (cacheDir, status) => run('moon',
    ['run', '--target', 'native', 'lint.mbtx', '--', sourceName, cacheDir], {
      cwd, status, env: { ...process.env, MOON_HOME: moonHome, XDG_CACHE_HOME: join(cwd, 'xdg-cache') },
    });

  for (const { caseName, probability, status } of [
    { caseName: 'finding', probability: 0.02, status: 1 },
    { caseName: 'pass', probability: 0.98, status: 0 },
    { caseName: 'miss', probability: undefined, status: 2 },
  ]) {
    const cacheDir = join(cwd, caseName);
    mkdirSync(cacheDir, { mode: 0o700 });
    if (probability !== undefined) {
      let requests = 0;
      const writer = createDecisionClient({
        cacheDir,
        ttlSeconds: 3600,
        mode: 'remote',
        token: 'mock-token',
        async fetch() {
          requests += 1;
          return Response.json({ model: request.model, answers: [{ type: 'predicate', name: request.name, probability }] });
        },
      });
      assert.equal(await writer.resolve(request), probability);
      assert.equal(requests, 1);
    }
    const expectedFiles = probability === undefined ? [] : [`${predicateKey(request)}.json`];
    assert.deepEqual(readdirSync(cacheDir), expectedFiles);
    const result = lint(cacheDir, status);
    if (status === 1) {
      assert.match(result.stdout, /sample_test\.mbt:1:\d+/u);
      assert.ok(result.stdout.includes(finding), result.stdout + result.stderr);
    } else {
      assert.ok(!result.stdout.includes(finding), result.stdout + result.stderr);
    }
    if (status === 2) assert.match(result.stdout + result.stderr, /CacheMiss/u);
    if (status === 0) assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(cacheDir), expectedFiles);
    t.diagnostic(`${caseName}: native lint exited ${status}`);
  }
  assert.equal(readFileSync(join(cwd, sourceName), 'utf8'), source);
});
