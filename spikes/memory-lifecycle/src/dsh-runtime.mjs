import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

// Load the installed implementation, including its own dependency graph.
export async function startDsh(root, persona) {
  const base = process.env.DSH_MODULES;
  if (!base) throw new Error('DSH_MODULES is required');
  const runtimeRequire = createRequire(join(base, '../package.json'));
  const names = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'];
  const mappings = new Map(names.map(n => [n, pathToFileURL(runtimeRequire.resolve(n)).href]));
  const hooks = registerHooks({ resolve(s, c, next) { return next(mappings.get(s) ?? s, c); } });
  const load = name => import(pathToFileURL(join(base, '@deepseek-ai', name, 'lib/index.js')));
  const { Context } = await load('cordis');
  const ctx = new Context();
  const privateDir = join(root, 'auth');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  const credentials = join(privateDir, '.credentials.yaml');
  // The official account provider can invalidate credentials after a 401. Give it an
  // isolated copy so an experiment can never log the user's Desktop account out.
  copyFileSync(process.env.DSH_CREDENTIALS ?? join(homedir(), '.dsh', '.credentials.yaml'), credentials);
  chmodSync(credentials, 0o600);
  async function mount(name, config = {}) {
    const m = await load(name);
    await ctx.plugin(m.default ?? m, config).await();
    return m;
  }
  const dispose = async () => {
    try { await ctx.fiber.dispose(); } finally { hooks.deregister(); rmSync(privateDir, { recursive: true, force: true }); }
  };
  try {
    await mount('dsh-credentials-local', { path: credentials, watch: false });
    await mount('dsh-authorization');
    await mount('dsh-deepseek-account-platform', { desktopPlatform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : null });
    if ((await ctx.deepseekAccount.getState()).status !== 'credential-stored') throw new Error('DSH_ACCOUNT_NOT_SIGNED_IN');
    await mount('dsh-llm');
    await mount('dsh-llm-deepseek-account', { retryPolicy: { mode: 'normal', maxRetries: 2,
      backoff: { initialDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0.2 } } });
    await mount('dsh-session');
    await mount('dsh-session-projection');
    await mount('dsh-session-persistence-jsonl', { root: join(root, 'sessions'), compression: 'none' });
    await mount('dsh-system-prompt', { includeRuntimeContext: false, personaPrefix: persona });
    const { defineTool } = await mount('dsh-tools');
    await mount('dsh-agent');
    await mount('dsh-llm-retry');
    await mount('dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 });
    const { createUserMessage } = await load('dsh-llm');
    return { ctx, defineTool, createUserMessage, dispose,
      dshVersion: JSON.parse(readFileSync(join(base, '@deepseek-ai/dsh-agent/package.json'), 'utf8')).version };
  } catch (e) { await dispose(); throw e; }
}
