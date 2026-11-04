import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, checkPackedFiles, inside } from '../scripts/release-config.mjs';
import { packRelease } from '../scripts/pack-release.mjs';
import { createHash } from 'node:crypto';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { schemaVersion: 1, repository: 'example/assistant', packageDirectory: 'plugin',
    assetName: 'assistant.tgz', releaseEnabled: true };
  const pkg = { name: 'assistant', version: '0.1.0', private: false, license: 'MIT',
    engines: { dsh: '0.2.1-rc.5' }, main: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['index.mjs', 'cordis.patch.yml'], scripts: { build: 'build', test: 'test', 'test:package': 'verify' } };
  mkdirSync(join(root, 'release')); mkdirSync(join(root, 'plugin'));
  const save = () => {
    writeFileSync(join(root, 'release/config.json'), JSON.stringify(config));
    writeFileSync(join(root, 'plugin/package.json'), JSON.stringify(pkg));
  };
  writeFileSync(join(root, 'plugin/index.mjs'), 'export function apply() {}');
  writeFileSync(join(root, 'plugin/cordis.patch.yml'), '[]');
  save(); return { root, config, pkg, save };
}

test('unready experiments cannot be released by creating a tag', t => {
  const f = fixture(t); f.config.releaseEnabled = false; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /RELEASE_NOT_READY/);
});
test('version, public package status and distributable bundle must agree', t => {
  const f = fixture(t);
  assert.equal(checkRelease(f.root, 'v0.1.0').pkg.version, '0.1.0');
  assert.throws(() => checkRelease(f.root, 'v0.2.0'), /TAG_VERSION_MISMATCH/);
  f.pkg.private = true; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /PACKAGE_NOT_PUBLIC/);
  f.pkg.private = false; f.pkg.dsh.bundle.patch = './missing.yml'; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /PACKAGE_ENTRY_MISSING/);
});
test('the release requires a license, a file allowlist and package acceptance command', t => {
  const f = fixture(t); f.pkg.license = 'UNLICENSED'; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /DISTRIBUTION_LICENSE_REQUIRED/);
  f.pkg.license = 'MIT'; f.pkg.files = ['*']; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /PACKAGE_FILE_ALLOWLIST_REQUIRED/);
  f.pkg.files = ['index.mjs']; delete f.pkg.scripts['test:package']; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /REQUIRED_SCRIPT_MISSING/);
});
test('runtime databases, credentials and parent paths cannot enter a release package', () => {
  checkPackedFiles([{ path: 'lib/index.js' }, { path: 'package.json' }]);
  for (const path of ['../secret', '.env.local', 'data/state.sqlite-wal', 'auth/.credentials.yaml', 'nested/key.pem', '.git/config']) {
    assert.throws(() => checkPackedFiles([{ path }]), /PRIVATE_OR_RUNTIME_FILE_IN_PACKAGE/);
  }
});
test('package paths stay inside the repository', t => {
  const f = fixture(t);
  assert.throws(() => inside(f.root, '../outside'), /PACKAGE_PATH_ESCAPES_ROOT/);
  assert.equal(inside(f.root, 'plugin'), join(f.root, 'plugin'));
});

test('pre-build validation permits generated entries but packing requires them', t => {
  const f = fixture(t); f.pkg.main = './dist/index.mjs'; f.save();
  assert.equal(checkRelease(f.root, 'v0.1.0', { built: false }).pkg.version, '0.1.0');
  assert.throws(() => checkRelease(f.root, 'v0.1.0'), /PACKAGE_ENTRY_MISSING/);
  f.pkg.main = '../outside'; f.save();
  assert.throws(() => checkRelease(f.root, 'v0.1.0', { built: false }), /PACKAGE_PATH_ESCAPES_ROOT/);
});

test('npm package, checksum and versioned metadata describe the same artifact', t => {
  const f = fixture(t);
  const metadata = packRelease(f.root, 'v0.1.0');
  const archive = readFileSync(join(f.root, 'dist/release/assistant.tgz'));
  assert.equal(metadata.sha256, createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual(metadata.files.sort(), ['cordis.patch.yml', 'index.mjs', 'package.json']);
  assert.equal(metadata.url, 'https://github.com/example/assistant/releases/download/v0.1.0/assistant.tgz');
  assert.equal(readFileSync(join(f.root, 'dist/release/SHA256SUMS'), 'utf8'), metadata.sha256 + '  assistant.tgz\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'dist/release/release.json'))), metadata);
});
