import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/memory-store.mjs';
import { seed, START } from '../src/fixtures.mjs';
import { runScenario } from '../src/scenario.mjs';
import { createHostPlugin, toolPort } from '../src/host-plugin.mjs';
import { saveReport } from './report.mjs';

const base = process.env.DSH_MODULES;
if (!base) throw new Error('Set DSH_MODULES to the installed DSH node_modules directory.');
const runtimeRequire = createRequire(join(base, '../package.json'));
const mappings = new Map(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']
  .map(name => [name, pathToFileURL(runtimeRequire.resolve(name)).href]));
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(mappings.get(specifier) ?? specifier, context); } });
const { Context } = await import(pathToFileURL(join(base, '@deepseek-ai/cordis/lib/index.js')));
const { default: SystemPrompt } = await import(pathToFileURL(join(base, '@deepseek-ai/dsh-system-prompt/lib/index.js')));
const { default: ToolRuntime, defineTool } = await import(pathToFileURL(join(base, '@deepseek-ai/dsh-tools/lib/index.js')));
const dshVersion = JSON.parse(readFileSync(join(base, '@deepseek-ai/dsh-tools/package.json'), 'utf8')).version;
const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-host-'));
const store = new MemoryStore(dir, { clock: () => START });
const ids = seed(store); store.close();
const ctx = new Context();
try {
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, {}).await();
  const plugin = createHostPlugin(defineTool);
  let fiber = ctx.plugin(plugin, { root: dir, clock: () => START }); await fiber.await();
  await assert.rejects(ctx.tools.get('spike_memory_get').execute({}, {}), /invalid arguments/);
  const result = await runScenario(toolPort(ctx.tools), ids);
  const count = () => ctx.tools.wireSchemas().schemas.filter(t => t.name.startsWith('spike_')).length;
  assert.equal(count(), 8);
  await fiber.dispose(); assert.equal(count(), 0);
  fiber = ctx.plugin(plugin, { root: dir, clock: () => START }); await fiber.await();
  assert.equal(count(), 8);
  const restored = await toolPort(ctx.tools).getMemory(ids.first);
  assert.equal(restored.data.notes, '这是我在整理之后补充的本次安排。');
  saveReport('dsh-host.json', { mode: 'installed-cordis-and-tool-runtime', dshVersion,
    syntheticClock: new Date(START).toISOString(), ...result,
    lifecycle: { argumentValidation: true, toolsRegistered: 8, disposed: true, reactivatedWithoutDuplicates: true, persistenceReopened: true } });
  console.log(JSON.stringify({ passed: true, dshVersion, stages: result.stages.map(s => s.step), report: 'artifacts/dsh-host.json' }));
} finally { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); }
