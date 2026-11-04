import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { root, checkRelease, checkPackedFiles, inside } from './release-config.mjs';

export function packRelease(base = root, releaseTag = process.env.GITHUB_REF_NAME) {
  const { config, pkg, directory, tag } = checkRelease(base, releaseTag);
  const out = join(base, 'dist/release');
  // Only generated output inside this repository is replaced.
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  if (!process.env.npm_execpath) throw new Error('RUN_VIA_NPM_RELEASE_PACK');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', out],
    { cwd: directory, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  const packs = JSON.parse(result.stdout);
  if (packs.length !== 1) throw new Error('EXPECTED_ONE_PACKAGE');
  checkPackedFiles(packs[0].files);
  const packed = inside(out, packs[0].filename);
  const target = join(out, config.assetName); renameSync(packed, target);
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  const metadata = { schemaVersion: 1, name: pkg.name, version: pkg.version, tag, dsh: pkg.engines.dsh,
    repository: config.repository, commit: process.env.GITHUB_SHA ?? null,
    url: 'https://github.com/' + config.repository + '/releases/download/' + tag + '/' + config.assetName,
    asset: config.assetName, sha256, files: packs[0].files.map(f => f.path) };
  writeFileSync(join(out, 'SHA256SUMS'), sha256 + '  ' + config.assetName + '\n');
  writeFileSync(join(out, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  writeFileSync(join(out, 'RELEASE_NOTES.md'), [
    '# DSH Personal Assistant ' + pkg.version, '',
    'DSH compatibility: ' + pkg.engines.dsh, '',
    'Install in DSH: Plugins → Add plugin → paste the package URL:', '', metadata.url, '',
    'Package checksum: SHA256SUMS. Release metadata: release.json.', '',
  ].join('\n'));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(packRelease()));
}
