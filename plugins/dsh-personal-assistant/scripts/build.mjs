import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';
import {dependencyNotice} from './license-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildNodeEntries(entries, outdir) {
  for (const [name, path] of Object.entries(entries)) {
    await build({
      entryPoints: [join(root, path)], outfile: join(outdir, name + '.js'),
      bundle: true, format: 'esm', platform: 'node', target: 'node24',
      packages: 'bundle', external: ['@deepseek-ai/*', '@napi-rs/keyring'],
      banner: {js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},
      legalComments: 'eof',
    });
  }
}

export async function buildPlugin() {
  const outdir = join(root, 'lib');
  await rm(outdir, {recursive: true, force: true});
  await mkdir(outdir, {recursive: true});
  const require = createRequire(import.meta.url), tz = require('@touch4it/ical-timezones');
  const names = Object.keys(require('@touch4it/ical-timezones/zones.js'));
  await writeFile(join(outdir, 'zones.json'), JSON.stringify(Object.fromEntries(names.map(name => [name, tz.getVtimezoneComponent(name)]))));
  await buildNodeEntries({host: 'src/host/index.ts', agent: 'src/host/agent.ts', worker: 'src/storage/worker.ts', 'migrate-v2': 'src/cli/migrate-v2.ts'}, outdir);
  const client = await build({
    entryPoints: [join(root, 'src/client/index.tsx')], bundle: true, format: 'cjs',
    platform: 'browser', target: 'chrome120', external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: {'.css': 'text'}, write: false, legalComments: 'eof',
  });
  await writeFile(join(outdir, 'client.js'), 'window.__ModuleLoader__.load({id:"dsh-personal-assistant",factory(require){var module={exports:{}};var exports=module.exports;\n' + client.outputFiles[0].text + '\nreturn module.exports;}});\n');
  // The repository root is the single source for project documentation and license.
  for (const name of ['README.md', 'LICENSE']) await copyFile(join(root, '../..', name), join(root, name));
  const licenses = await Promise.all(['zod', 'ical.js', 'js-yaml', 'qrcode', 'pngjs', 'dijkstrajs', '@touch4it/ical-timezones', '@napi-rs/keyring']
    .map(name => dependencyNotice(join(root, 'node_modules', name))));
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), licenses.join('\n\n'));
  console.log('Built plugin runtime and package metadata.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildPlugin();
