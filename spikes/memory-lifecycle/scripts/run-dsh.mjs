import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, artifacts, sourceHashes } from './report.mjs';

const executable = process.env.DSH_EXECUTABLE ?? (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : null);
const modules = process.env.DSH_MODULES ?? (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules' : null);
if (!executable || !modules || !existsSync(executable)) throw new Error('Set DSH_EXECUTABLE and DSH_MODULES for this installation.');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_MODULES: modules };
mkdirSync(artifacts, { recursive: true });
function run(args) {
  const result = spawnSync(executable, ['--expose-internals', ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? ''); process.stdout.write(result.stdout ?? '');
    throw result.error ?? new Error(`DSH verification failed: ${result.status}`);
  }
  return result;
}
const info = JSON.parse(run(['--input-type=module', '-e', 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(":memory:");console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,sqlite:db.prepare("select sqlite_version() as version").get().version}));db.close()']).stdout);
const tests = run(['--test', '--test-reporter=tap', 'test/lifecycle.test.mjs']);
writeFileSync(join(artifacts, 'dsh-tests.tap'), tests.stdout);
const count = label => Number(tests.stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1]);
const report = { verifiedAt: new Date().toISOString(), ...info, sourceHashes: sourceHashes(),
  mode: 'dsh-bundled-node', tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') };
if (!Number.isFinite(report.tests) || report.failed || report.skipped || report.tests !== report.passed) throw new Error('Unexpected test summary');
writeFileSync(join(artifacts, 'dsh-tests.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, (key, value) => key === 'sourceHashes' ? undefined : value));
process.stdout.write(run(['scripts/verify-host.mjs']).stdout);
