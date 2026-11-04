import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function dependencyNotice(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  // Enumerate real filenames: existence probes hide casing errors on macOS and Windows.
  const files = (await readdir(directory, {withFileTypes: true}))
    .filter(entry => entry.isFile() && /^(?:licen[sc]e|copying)(?:\.(?:txt|md))?$/i.test(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error('DEPENDENCY_LICENSE_MISSING: ' + manifest.name);
  const texts = await Promise.all(files.map(async filename => {
    const text = await readFile(join(directory, filename), 'utf8');
    if (!text.trim()) throw new Error('DEPENDENCY_LICENSE_EMPTY: ' + manifest.name + '/' + filename);
    return text;
  }));
  return '# ' + manifest.name + ' ' + manifest.version + '\n\n' + texts.join('\n\n');
}
