import { spawn } from 'node:child_process';
import { root } from './report.mjs';

const executable = process.env.DSH_EXECUTABLE ?? (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' : null);
const modules = process.env.DSH_MODULES ?? (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules' : null);
if (!executable || !modules) throw new Error('Set DSH_EXECUTABLE and DSH_MODULES');
const child = spawn(executable, ['--expose-internals', 'scripts/live-model.mjs'], { cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_MODULES: modules }, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
