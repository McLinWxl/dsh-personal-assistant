import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dependencyNotice} from '../scripts/license-notices.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-licenses-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'sample-dependency', version: '1.2.3'}));
  return root;
}

test('dependency notices preserve license text across filename conventions and case-sensitive filesystems', async t => {
  for (const filename of ['LICENSE', 'license', 'License.MD', 'licence.txt', 'COPYING']) {
    const root = await fixture(t);
    await writeFile(join(root, filename), 'Copyright holder\nPermission terms.\n');
    await writeFile(join(root, 'README.md'), 'Not a license');
    assert.equal(await dependencyNotice(root), '# sample-dependency 1.2.3\n\nCopyright holder\nPermission terms.\n');
  }
});

test('dependency notices fail clearly for missing, non-file or empty licenses', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'LICENSE'));
  await assert.rejects(dependencyNotice(root), /DEPENDENCY_LICENSE_MISSING: sample-dependency/);
  await writeFile(join(root, 'COPYING'), '  \n');
  await assert.rejects(dependencyNotice(root), /DEPENDENCY_LICENSE_EMPTY: sample-dependency\/COPYING/);
});
