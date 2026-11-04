import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory-store.mjs';
import { seed, localPort, START } from '../src/fixtures.mjs';
import { runScenario } from '../src/scenario.mjs';
import { saveReport } from './report.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-demo-'));
const store = new MemoryStore(dir, { clock: () => START });
try {
  const result = await runScenario(localPort(store), seed(store));
  saveReport('scenario.json', { mode: 'direct-sqlite', syntheticClock: new Date(START).toISOString(), ...result });
  console.log(JSON.stringify({ passed: result.passed, stages: result.stages.map(s => s.step), report: 'artifacts/scenario.json' }));
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
