import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const artifacts = join(root, 'artifacts');
export function sourceHashes() {
  const result = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else result[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  for (const dir of ['src', 'test', 'scripts']) visit(join(root, dir));
  result['package.json'] = createHash('sha256').update(readFileSync(join(root, 'package.json'))).digest('hex');
  return result;
}
export function saveReport(name, report) {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, name), JSON.stringify({ verifiedAt: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, sourceHashes: sourceHashes(), ...report }, null, 2) + '\n');
}
