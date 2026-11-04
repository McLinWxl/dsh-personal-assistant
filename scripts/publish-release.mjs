import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { root, checkRelease } from './release-config.mjs';

const { config, pkg, tag } = checkRelease();
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== config.repository) throw new Error('EXPECTED_REPOSITORY_ACTIONS_RUN');
const out = join(root, 'dist/release');
const metadata = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'));
if (metadata.tag !== tag || metadata.version !== pkg.version || metadata.commit !== process.env.GITHUB_SHA) throw new Error('STALE_RELEASE_ARTIFACT');
const names = [config.assetName, 'SHA256SUMS', 'release.json'];
if (names.some(n => !existsSync(join(out, n)))) throw new Error('MISSING_RELEASE_ASSET');
const checksum = createHash('sha256').update(readFileSync(join(out, config.assetName))).digest('hex');
if (checksum !== metadata.sha256 || readFileSync(join(out, 'SHA256SUMS'), 'utf8') !== checksum + '  ' + config.assetName + '\n') throw new Error('CHECKSUM_MISMATCH');
function gh(args) {
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error('GITHUB_RELEASE_FAILED');
}
const prerelease = pkg.version.includes('-');
gh(['release', 'create', tag, ...names.map(n => join(out, n)), '--repo', config.repository,
  '--verify-tag', '--draft', '--title', pkg.name + ' ' + pkg.version, '--notes-file', join(out, 'RELEASE_NOTES.md'),
  ...(prerelease ? ['--prerelease'] : [])]);
gh(['release', 'edit', tag, '--repo', config.repository, '--draft=false', '--latest=' + !prerelease]);
